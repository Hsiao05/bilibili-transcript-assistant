@echo off
chcp 936 >nul
title B站文字稿助手 - 启动器
cd /d "%~dp0services\task-api"

if not exist ".venv\Scripts\python.exe" (
  echo [错误] 还没有安装任务服务环境。
  echo 请先按“使用说明.md”第 2 步安装 Python 依赖，然后再双击本文件。
  echo.
  pause
  exit /b 1
)

echo 正在启动任务服务，会打开两个窗口...
echo.
start "B站文字稿助手-API" "%~dp0services\task-api\.venv\Scripts\python.exe" -m taskapi.serve
start "B站文字稿助手-Worker" "%~dp0services\task-api\.venv\Scripts\python.exe" -m taskapi.worker
echo 已启动。使用期间不要关闭这两个窗口；关闭它们即停止服务。
echo 第一次启动时，请在 API 窗口里找到并复制“访问令牌”。
echo.
timeout /t 8 >nul