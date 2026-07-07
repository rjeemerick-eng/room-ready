@echo off
REM Rock Kids Board – First-time Setup (Windows)

cd /d "%~dp0"

echo.
echo ==========================================
echo   Rock Kids Board -- First-time Setup
echo ==========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo   Node.js is not installed.
  echo.
  echo   Please install Node.js first:
  echo   Go to https://nodejs.org
  echo   Download and install the LTS version
  echo   Then run this setup file again.
  echo.
  start https://nodejs.org
  pause
  exit /b
)

echo   Node.js found.
echo.
echo   Installing app... (this may take a minute)
echo.

npm install

if %errorlevel% equ 0 (
  echo.
  echo ==========================================
  echo   Setup complete!
  echo.
  echo   From now on, just double-click:
  echo   "START Rock Kids.bat"
  echo ==========================================
  echo.
  pause
  npm start
) else (
  echo.
  echo   Setup failed. Please try again.
  pause
)
