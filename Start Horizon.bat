@echo off
setlocal

rem  Horizon launcher.
rem
rem  Double-click this file. It checks for Node.js, then starts the local web
rem  server and opens the page. Foundry Local can be installed and started from
rem  the page itself, so this does not require it up front.

title Horizon
cd /d "%~dp0"

echo.
echo   Horizon
echo   Your models, running on your machine
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js was not found.
  echo.
  echo   Horizon needs Node.js 18 or later. Install it from an approved
  echo   source, close this window, then run Start Horizon again.
  echo.
  echo   https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem  Node prints its version as v22.1.0; take the digits before the first dot.
for /f "tokens=1 delims=." %%v in ('node --version') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"

if %NODE_MAJOR% LSS 18 (
  echo   Node.js 18 or later is required.
  node --version
  echo.
  echo   Update Node.js, then run Start Horizon again.
  echo.
  pause
  exit /b 1
)

rem  Dictation needs node-pty, which is a real dependency rather than an
rem  optional one: a feature nobody knows to install is a feature nobody uses.
rem  Fetching it here means the ZIP download works the same as a git clone,
rem  without asking anyone to open a terminal first.
if not exist "node_modules\node-pty" (
  echo   Setting up, one moment. This happens once.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Setup did not finish. Horizon still runs and chat works normally;
    echo   speaking instead of typing will not be available.
    echo.
    timeout /t 5 >nul
  )
  echo.
)

echo   Starting the local server...
echo   Keep this window open while you use Horizon.
echo   Press Ctrl+C here when you are finished.
echo.

node "src\server.js"

echo.
echo   Horizon has stopped.
echo.
pause
