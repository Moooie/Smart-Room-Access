@echo off
cd /d "%~dp0"
TITLE Smart Scheduled Room Access System
COLOR 0A

echo ==========================================================
echo    SMART SCHEDULED ROOM ACCESS SYSTEM (IoT LAYER 3 dan 4)
echo ==========================================================
echo.
echo [1/3] Memeriksa MySQL...
echo Pastikan modul MySQL di XAMPP Control Panel sudah aktif (Running).
echo.
echo [2/3] Menjalankan MQTT Broker (Port 1884)...
start "SmartRoom MQTT Broker" cmd /k "node broker.js"
timeout /t 2 /nobreak >nul

echo.
echo [3/3] Menjalankan Backend dan Web Dashboard (Port 3000)...
start "SmartRoom Backend Server" cmd /k "node server.js"
timeout /t 2 /nobreak >nul

echo.
echo Membuka Web Dashboard di browser...
start http://localhost:3000

echo ==========================================================
echo Sistem telah berhasil dijalankan!
echo Web Dashboard : http://localhost:3000
echo MQTT Broker    : port 1884
echo ==========================================================
pause
