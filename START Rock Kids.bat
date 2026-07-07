@echo off
REM Rock Kids Board – Launch (Windows)
REM Double-click this every Sunday to start the board.

cd /d "%~dp0"

if not exist "node_modules" (
  echo.
  echo  Setup hasn't been run yet.
  echo  Please double-click "SETUP (Run Once).bat" first.
  echo.
  pause
  exit /b
)

npm start
