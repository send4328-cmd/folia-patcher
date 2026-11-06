@echo off
setlocal
cd /d "%~dp0"

rem Ask for administrator rights when started without arguments (Folia usually lives in Program Files).
if "%~1"=="" (
  net session >nul 2>&1
  if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
    if not errorlevel 1 exit /b
  )
)

rem Run patcher.js with the Node runtime built into Folia.exe; fall back to an installed node.
set "RUNNER="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-folia.ps1"`) do set "RUNNER=%%P"

if defined RUNNER (
  set "ELECTRON_RUN_AS_NODE=1"
  "%RUNNER%" "%~dp0patcher.js" %*
) else (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Folia.exe was not found and Node.js is not installed.
    echo See README.md for how to run patcher.js manually.
  ) else (
    node "%~dp0patcher.js" %*
  )
)

if "%~1"=="" pause
