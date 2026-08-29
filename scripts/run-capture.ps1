# 启动真实世界采集端客户端（vendor/stevex-template-1.21.11）
# 首次运行会联网下载 Gradle 9.5.1、Fabric 依赖与 Minecraft 客户端 jar。
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Mod = Join-Path $Root 'vendor\stevex-template-1.21.11'

Write-Host "[steveX] 启动采集端（真实世界）: $Mod"
Write-Host "[steveX] 进入世界后 WS API 监听端口 25550"

Set-Location $Mod
.\gradlew.bat runClient
