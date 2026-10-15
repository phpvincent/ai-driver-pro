// 视频学习副驾 · 本地知识库 companion（SPEC-16/17，Go 重写版）。
//
// 零依赖（标准库 net/http + crypto/rand）：替代 Bun 单文件编译的 90MB 底座，
// 产物 ~2.5MB，可入库分发（推代码即发布，无需手动传 Releases）。
//
// 协议与 TS 版逐行为对齐（Local REST API 子集）：
//   - GET    /vault/            → 根目录列表 {"files":[...]}
//   - GET    /vault/{path}      → 读文件
//   - PUT    /vault/{path}      → 写文件（自动建父目录）
//   - DELETE /vault/{path}      → 删文件（体检修复：孤儿概念页清理）
//   - Bearer 鉴权；仅监听 127.0.0.1:28123
//
// 数据目录默认 ~/vsc-knowledge（VSC_KNOWLEDGE_DIR 覆盖）；API Key 首启生成
// 存 .vsc-key 并打印。路径防穿越：逐段拒绝 .. / 空 / 分隔符 / NUL。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	defaultPort = "28123"
	defaultHost = "127.0.0.1"
	keyFile     = ".vsc-key"
)

// dataDir 数据目录：环境变量优先，默认 ~/vsc-knowledge
func dataDir() string {
	if d := strings.TrimSpace(os.Getenv("VSC_KNOWLEDGE_DIR")); d != "" {
		if abs, err := filepath.Abs(d); err == nil {
			return abs
		}
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("无法定位用户主目录：%v", err)
	}
	return filepath.Join(home, "vsc-knowledge")
}

// ensureAPIKey 取（或首启生成）API Key；存在且 ≥16 字符则复用
func ensureAPIKey(dir string) (string, error) {
	keyPath := filepath.Join(dir, keyFile)
	if b, err := os.ReadFile(keyPath); err == nil {
		if k := strings.TrimSpace(string(b)); len(k) >= 16 {
			return k, nil
		}
	}
	raw := make([]byte, 18)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("生成 Key 失败：%w", err)
	}
	key := "vsc-" + hex.EncodeToString(raw)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(keyPath, []byte(key+"\n"), 0o600); err != nil {
		return "", err
	}
	return key, nil
}

// safeVaultPath 路径安全解析：拒绝 .. / 空 / 斜杠内嵌 / NUL；返回空串表示根目录
func safeVaultPath(raw string) (string, bool) {
	raw = strings.Trim(raw, "/")
	if raw == "" {
		return "", true
	}
	for _, seg := range strings.Split(raw, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", false
		}
		if strings.ContainsAny(seg, "\x00\\") {
			return "", false
		}
	}
	return raw, true
}

// listRoot 根目录列表（Local REST API 兼容形状；隐藏 .vsc-key）
func listRoot(dir string) map[string][]string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return map[string][]string{"files": {}}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.Name() != keyFile {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return map[string][]string{"files": names}
}

func sendJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func sendText(w http.ResponseWriter, status int, contentType, body string) {
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// newServer 构造 http.Handler（测试经 httptest 直接驱动，不走网络端口）
func newServer(dir, key string) http.Handler {
	mux := http.NewServeMux()
	vaultHandler := func(w http.ResponseWriter, r *http.Request) {
		// /vault 与 /vault/ 都归一为根目录列表（与 TS 版语义对齐）
		if !strings.HasPrefix(r.URL.Path, "/vault") {
			sendJSON(w, http.StatusNotFound, map[string]string{"error": "not found（只提供 /vault/* 接口）"})
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+key {
			sendJSON(w, http.StatusUnauthorized, map[string]string{"error": "鉴权失败：请在扩展设置粘贴 companion 启动时打印的 API Key"})
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, "/vault")
		vaultPath, ok := safeVaultPath(rest)
		if !ok {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "非法路径"})
			return
		}
		abs := filepath.Join(dir, filepath.FromSlash(vaultPath))

		switch {
		case vaultPath == "" && r.Method == http.MethodGet:
			sendJSON(w, http.StatusOK, listRoot(dir))
		case r.Method == http.MethodGet:
			b, err := os.ReadFile(abs)
			if err != nil {
				sendJSON(w, http.StatusNotFound, map[string]string{"error": "文件不存在：" + vaultPath})
				return
			}
			ct := "text/markdown; charset=utf-8"
			if strings.HasSuffix(vaultPath, ".json") {
				ct = "application/json; charset=utf-8"
			}
			sendText(w, http.StatusOK, ct, string(b))
		case r.Method == http.MethodPut:
			body := make([]byte, 0, 1<<16)
			buf := make([]byte, 32*1024)
			for {
				n, err := r.Body.Read(buf)
				body = append(body, buf[:n]...)
				if err != nil {
					break
				}
			}
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "写入失败：" + err.Error()})
				return
			}
			if err := os.WriteFile(abs, body, 0o644); err != nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "写入失败：" + err.Error()})
				return
			}
			sendJSON(w, http.StatusOK, map[string]bool{"ok": true})
		case r.Method == http.MethodDelete:
			st, err := os.Stat(abs)
			if err != nil || st.IsDir() {
				sendJSON(w, http.StatusNotFound, map[string]string{"error": "文件不存在：" + vaultPath})
				return
			}
			if err := os.Remove(abs); err != nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "删除失败：" + err.Error()})
				return
			}
			sendJSON(w, http.StatusOK, map[string]bool{"ok": true})
		default:
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "不支持的请求方法：" + r.Method})
		}
	}
	// Go 1.22+ mux："/vault" 精确匹配、" /vault/" 子树匹配——两者共用同一 handler
	mux.HandleFunc("/vault", vaultHandler)
	mux.HandleFunc("/vault/", vaultHandler)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		sendJSON(w, http.StatusNotFound, map[string]string{"error": "not found（只提供 /vault/* 接口）"})
	})
	return mux
}

func main() {
	dir := dataDir()
	key, err := ensureAPIKey(dir)
	if err != nil {
		log.Fatalf("初始化失败：%v", err)
	}
	// 端口可覆盖（测试/多实例用）；默认 28123 与扩展约定一致
	port := strings.TrimSpace(os.Getenv("VSC_COMPANION_PORT"))
	if port == "" {
		port = defaultPort
	}
	addr := net.JoinHostPort(defaultHost, port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("端口 %s 被占用（是否已开了一个 companion？）：%v", addr, err)
	}
	fmt.Println("========================================")
	fmt.Println(" 视频学习副驾 · 本地知识库服务已启动")
	fmt.Println("----------------------------------------")
	fmt.Printf(" 数据目录：%s\n", dir)
	fmt.Println("   （装了 Obsidian？直接「打开文件夹为仓库」即可浏览这些笔记）")
	fmt.Printf(" 接口地址：http://%s\n", addr)
	fmt.Println(" API Key（粘贴到扩展 设置 → 个人知识库）：")
	fmt.Printf("   %s\n", key)
	fmt.Println("----------------------------------------")
	fmt.Println(" 保持本窗口开启即可；关闭窗口 = 停止服务")
	fmt.Println("========================================")
	log.Fatal(http.Serve(ln, newServer(dir, key)))
}
