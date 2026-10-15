#!/usr/bin/env bash
# companion 单二进制打包（SPEC-16）：bun compile → Windows / macOS 各一个文件。
# 产物放 companion/dist/，发布时上传 GitHub Releases。
# 依赖：bun ≥ 1.2（brew install bun 或 curl -fsSL https://bun.sh/install | bash）
set -euo pipefail
cd "$(dirname "$0")"  # companion/ 目录

mkdir -p dist

bun build src/companion.ts --compile --target=bun-windows-x64 --outfile "dist/vsc-knowledge-win64.exe"
bun build src/companion.ts --compile --target=bun-darwin-x64 --outfile "dist/vsc-knowledge-macos"
chmod +x "dist/vsc-knowledge-macos"

ls -lh dist/
echo "OK → companion/dist/（上传 GitHub Releases 供扩展设置页引导下载）"
