@echo off
chcp 65001 >nul
setlocal

REM ====================================================================
REM  dsh launcher - double-click to start the DeepSeek Harness.
REM
REM  Usage:
REM    double-click                        start the stevex profile
REM                                        (= dsh --profile stevex)
REM    start-dsh.bat web                   start DSH's stock web profile
REM    start-dsh.bat headless "do a task"  one-shot task
REM    start-dsh.bat --version             print version
REM  Everything after the script name is passed through to dsh.
REM
REM  DSH is installed as an exact npm dependency at the steveX root.
REM  Run npm install once after cloning; no vendored DSH source build is
REM  required. This file stays ASCII-only for reliable cmd.exe parsing.
REM ====================================================================

title dsh - DeepSeek Harness
cd /d "%~dp0"
if errorlevel 1 goto :no_project

where node >nul 2>nul
if errorlevel 1 goto :no_node

if not exist "node_modules\.bin\dsh.cmd" goto :no_deps
goto :launch

REM -- error branches --------------------------------------------------
:no_project
echo [ERROR] Could not enter the steveX project directory.
goto :fail

:no_node
echo [ERROR] node was not found on PATH. Install Node.js 22.19.x or newer.
goto :fail

:no_deps
echo [ERROR] Dependencies are not installed. Run this first:
echo.
echo         cd /d "%~dp0"
echo         npm install
echo.
goto :fail

REM -- launch ----------------------------------------------------------
:launch
if "%~1"=="" (set "DSH_ARGS=stevex") else (set "DSH_ARGS=%*")
echo [launch] dsh %DSH_ARGS%
echo.
call npm run dsh -- %DSH_ARGS%
if errorlevel 1 goto :fail

endlocal
exit /b 0

:fail
echo.
echo [FAILED] See the message above. Press any key to close...
pause >nul
endlocal
exit /b 1
