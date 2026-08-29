# 启动记忆世界 restorer 客户端（vendor/stevex-test-template-1.21.11）
# 文件驱动：按 mtime 门控读取采集端落盘的 <stevex/vision/*.nbt> 复现记忆世界。
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Mod = Join-Path $Root 'vendor\stevex-test-template-1.21.11'

Write-Host "[steveX] 启动记忆世界客户端: $Mod"

Set-Location $Mod
.\gradlew.bat runClient
