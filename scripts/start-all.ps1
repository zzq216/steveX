# 一键启动整条链路（各进程独立窗口）：
#   1) 采集端（真实世界）→ 2) steveX（脑，Web 面板 8090）→ 3) 记忆端（记忆世界）
# 记忆世界为文件驱动独立进程，不依赖 steveX；采集端进入世界后链路即通。
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$Capture = Join-Path $Root 'vendor\stevex-template-1.21.11'
$Memory  = Join-Path $Root 'vendor\stevex-test-template-1.21.11'

Write-Host "[steveX] 启动顺序：采集端 → steveX → 记忆端（各开独立窗口）"

# 1) 采集端（真实世界）— 首次运行联网下载依赖/客户端，耗时较长
Start-Process powershell -NoExit -WorkingDirectory $Capture `
  -ArgumentList '-Command', '.\gradlew.bat runClient'

Start-Sleep -Seconds 2

# 2) steveX（脑）— Web 面板 http://localhost:8090
Start-Process powershell -NoExit -WorkingDirectory $Root `
  -ArgumentList '-Command', 'npm start'

Start-Sleep -Seconds 1

# 3) 记忆端（记忆世界）— 文件驱动，独立进程
Start-Process powershell -NoExit -WorkingDirectory $Memory `
  -ArgumentList '-Command', '.\gradlew.bat runClient'

Write-Host "[steveX] 已拉起 3 个进程。"
Write-Host "[steveX] 采集端进入世界后：Web 面板 http://localhost:8090，mod WS 端口 25550"
Write-Host "[steveX] 验证：node test_mod_api.js --stevex"
