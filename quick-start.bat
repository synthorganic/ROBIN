@echo off
setlocal

cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo [ROBIN] npm was not found in PATH.
  echo [ROBIN] Install Node.js 22+ and try again.
  exit /b 1
)

if not exist node_modules (
  echo [ROBIN] Installing dependencies...
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

if not exist dist\index.html (
  echo [ROBIN] Building app...
  call npm run build
  if errorlevel 1 exit /b %errorlevel%
) else if not exist server-dist\index.js (
  echo [ROBIN] Building server bundle...
  call npm run build
  if errorlevel 1 exit /b %errorlevel%
)

if not exist .env (
  echo [ROBIN] .env was not found. Run "npm run setup" if you still need initial configuration.
)

echo [ROBIN] Starting...
call npm run start
exit /b %errorlevel%
