#!/bin/sh
# 启动本地文件智能整理器并打开浏览器
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 检查是否已经在运行
if pgrep -f "node server.js" > /dev/null 2>&1; then
  echo "应用已在运行中"
  # 尝试打开浏览器
  if command -v open >/dev/null 2>&1; then
    open http://localhost:38211
  fi
  exit 0
fi

# 启动服务器
node server.js &
SERVER_PID=$!

# 等待服务器启动
sleep 2

# 打开浏览器
if command -v open >/dev/null 2>&1; then
  open http://localhost:38211
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open http://localhost:38211
fi

echo "应用已启动，访问地址: http://localhost:38211"
echo "按 Ctrl+C 停止"

# 等待服务器进程
wait $SERVER_PID