#!/bin/bash
# WhisperNote - One-command starter for macOS/Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "WhisperNote..."

# Check Python
if ! command -v python3 &> /dev/null && ! command -v python &> /dev/null; then
    echo "Python not found. Install from https://python.org"
    exit 1
fi

PYTHON=$(command -v python3 || command -v python)

# Check if dependencies are installed
if ! "$PYTHON" -c "import faster_whisper" 2>/dev/null; then
    echo "Installing dependencies..."
    "$PYTHON" -m pip install -q faster-whisper sounddevice numpy httpx pywebview
fi

# Run the app
exec "$PYTHON" -m src.app "$@"