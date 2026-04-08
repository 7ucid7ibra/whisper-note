@echo off
REM WhisperNote - One-command starter for Windows

cd /d "%~dp0"

echo WhisperNote...

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo Python not found. Install from https://python.org
    pause
    exit /b 1
)

REM Check if dependencies are installed
python -c "import faster_whisper" 2>nul
if errorlevel 1 (
    echo Installing dependencies...
    python -m pip install -q faster-whisper sounddevice numpy httpx pywebview
)

REM Run the app
python -m src.app %*
pause