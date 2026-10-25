#!/bin/bash
# 本地 PDF 工具箱启动脚本 (macOS / Linux)
cd "$(dirname "$0")"

echo "正在启动本地 PDF 工具箱..."

# 优先用 node，其次 python
if command -v node >/dev/null 2>&1; then
  ( sleep 1; open "http://127.0.0.1:8642/" ) 2>/dev/null || \
  ( sleep 1; xdg-open "http://127.0.0.1:8642/" ) 2>/dev/null || true
  node server.js
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  ( sleep 1; open "http://127.0.0.1:8642/" ) 2>/dev/null || \
  ( sleep 1; xdg-open "http://127.0.0.1:8642/" ) 2>/dev/null || true
  python3 -m http.server 8642 --bind 127.0.0.1
  exit 0
fi

echo "未检测到 Node.js 或 Python3，请先安装任一个后再运行。"
read -r -p "按回车退出..."
