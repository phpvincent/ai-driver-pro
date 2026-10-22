#!/usr/bin/env bash
# 分发 zip 打包（ai-driver-pro）：dist 即完整的可加载扩展，**只打包 dist 内容**。
#
# 事故教训（2026-10-14）：曾把仓库根目录的源码 panel.html（引用 /src/panel/main.tsx）
# 拷进 zip 覆盖构建版（引用 ./panel.js），zip 里没有 src/ → 模块 404 → 面板白屏。
# 规则：**除 dist 外不拷任何文件**；打完必须校验 panel.html 引用的是 ./panel.js。
#
# 用法：./scripts/package-zip.sh [输出路径]（默认 ../ai-driver-pro-v<版本>.zip 相对仓外）
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
OUT="${1:-../ai-driver-pro-v${VERSION}.zip}"

rm -rf /tmp/ai-driver-pro-pkg
mkdir -p /tmp/ai-driver-pro-pkg/ai-driver-pro
cp -R dist/. /tmp/ai-driver-pro-pkg/ai-driver-pro/
cd /tmp/ai-driver-pro-pkg
rm -f "$OUT"
zip -rq "$OUT" ai-driver-pro

# 打包自检：panel.html 必须引用构建产物（./panel.js），引用 /src/ 即白屏
if unzip -p "$OUT" ai-driver-pro/panel.html | grep -q '/src/'; then
  echo 'ERROR: zip 内 panel.html 引用了 /src/（源码版），加载会白屏！打包被中止。' >&2
  exit 1
fi
echo "OK: $OUT"
unzip -l "$OUT" | tail -2
