# steveX 首次运行引导：
#   1) 校验 JDK 21+（mod 构建要求，CI 证明 21–25 均可）
#   2) 安装 node 依赖（node_modules 缺失时）
#   3) 打印启动指引
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== steveX 环境引导 ==="

# ── 1) Java ──
$javaCmd = Get-Command java -ErrorAction SilentlyContinue
if (-not $javaCmd) {
    Write-Host "[错误] 未找到 java。请安装 JDK 21+ 并加入 PATH（https://adoptium.net/）" -ForegroundColor Red
    exit 1
}
# java -version 输出到 stderr；在 cmd 层合并流，避免 PS5.1 在 $ErrorActionPreference=Stop 下把 stderr 当作错误抛出
$versionLine = (& cmd /c 'java -version 2>&1' | Select-Object -First 1)
Write-Host "  检测到: $versionLine"
if ($versionLine -notmatch '"(\d+)') {
    Write-Host "[错误] 无法解析 java 版本号" -ForegroundColor Red
    exit 1
}
$major = [int]$Matches[1]
if ($major -lt 21) {
    Write-Host "[错误] 需要 JDK 21+，当前主版本为 $major。请升级后重试。" -ForegroundColor Red
    exit 1
}
Write-Host "  JDK 版本满足要求（>=21）" -ForegroundColor Green

# ── 2) Node 依赖 ──
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Host "  首次运行，安装 node 依赖..."
    Push-Location $Root
    npm install
    Pop-Location
} else {
    Write-Host "  node_modules 已存在，跳过 npm install"
}

# ── 3) 启动指引 ──
Write-Host ""
Write-Host "=== 完成。启动方式 ===" -ForegroundColor Green
Write-Host "  一键启动整条链路:   npm run start:all"
Write-Host "  或手动分步:         npm run mc:capture  →  npm start  →  npm run mc:memory"
Write-Host "  Web 面板:           http://localhost:8090"
Write-Host "  API 验证:           node test_mod_api.js --stevex"
