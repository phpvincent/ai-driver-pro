#!/usr/bin/env bash
# companion 交叉编译（SPEC-16/17，Go 重写版）：四平台单二进制，产物 ~2.5MB 入库分发
#（companion/bin/ 提交进 git——推代码即发布，无需手动传 Releases）。
# 依赖：go ≥ 1.22（标准库全覆盖，无第三方依赖）
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p bin
build_one() {
  local goos="$1" goarch="$2" out="$3"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "bin/$out" .
}
build_one darwin   arm64 vsc-knowledge-macos-arm64
build_one darwin   amd64 vsc-knowledge-macos-x64
build_one windows  amd64 vsc-knowledge-win64.exe
build_one linux    amd64 vsc-knowledge-linux
chmod +x bin/*
ls -lh bin/
echo "OK → companion/bin/（已入库：推代码即发布）"
