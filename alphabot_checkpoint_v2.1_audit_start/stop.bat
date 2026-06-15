@echo off
echo ========================================================
echo Stopping Alphabot v2.0 Servers...
echo ========================================================
echo.

echo [INFO] Stopping Backend Server on Port 8000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a 2>nul
)

echo [INFO] Stopping Frontend Server on Port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a 2>nul
)

echo.
echo ========================================================
echo Alphabot servers have been stopped.
echo ========================================================
echo.
pause
