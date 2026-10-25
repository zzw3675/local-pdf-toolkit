@echo off
chcp 65001 >nul
title 本地 PDF 工具箱
cd /d "%~dp0"

echo 正在启动本地 PDF 工具箱...
echo.

where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://127.0.0.1:8642/
  node server.js
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://127.0.0.1:8642/
  python -m http.server 8642 --bind 127.0.0.1
  goto :eof
)

echo 未检测到 Node.js 或 Python，请先安装任一个后，再运行本脚本。
echo 官网下载: Node.js https://nodejs.org  /  Python https://www.python.org
pause
