# B站文字稿助手：一键启动任务服务（API + worker）
#
# 用法（仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\start-task-service.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-task-service.ps1 -NoWorker
#
# Ctrl+C 会同时结束 API 与 worker。启动横幅里会打印配对 token。
param(
  [switch]$NoWorker
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$serviceDir = Join-Path $root "services\task-api"
$python = Join-Path $serviceDir ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
  throw "未找到 $python。请先按 README 第 1 节创建 services/task-api/.venv。"
}

$worker = $null
Push-Location $serviceDir
try {
  if (-not $NoWorker) {
    Write-Host "[start] 启动 worker ..." -ForegroundColor Cyan
    $worker = Start-Process -FilePath $python `
      -ArgumentList @("-u", "-m", "taskapi.worker") `
      -WorkingDirectory $serviceDir -NoNewWindow -PassThru
  }
  Write-Host "[start] 启动 API（Ctrl+C 结束全部进程）..." -ForegroundColor Cyan
  & $python -u -m taskapi.serve
} finally {
  if ($worker -and -not $worker.HasExited) {
    Write-Host "[stop] 结束 worker (PID $($worker.Id))" -ForegroundColor Yellow
    & taskkill /PID $worker.Id /T /F 2>$null | Out-Null
  }
  Pop-Location
}
