#!/bin/bash
# WhisperNote - One-command starter for macOS/Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "WhisperNote..."

# Use existing venv if available, otherwise create local one.
VENV_DIR="$SCRIPT_DIR/.venv"
ALT_VENV_CANDIDATES=(
    "/Users/tehuti/Documents/MyDocuments/Development/DevDB/AllProjects/3layer-rag/.venv"
    "/Users/tehuti/Documents/MyDocuments/Development/Dev_Archive/Projects/3_Memory-Systems/3layer-rag/.venv"
    "/Users/tehuti/Documents/MyDocuments/Development/DevDump/3layer-rag/.venv"
)

for ALT_VENV in "${ALT_VENV_CANDIDATES[@]}"; do
    if [ -d "$ALT_VENV" ]; then
        VENV_DIR="$ALT_VENV"
        break
    fi
done

if [ "$VENV_DIR" != "$SCRIPT_DIR/.venv" ]; then
    echo "Using shared virtual environment: $VENV_DIR"
elif [ ! -d "$VENV_DIR" ]; then
    echo "Creating local virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Get the python from venv
PYTHON="$VENV_DIR/bin/python"

echo "Python: $PYTHON"
"$PYTHON" -V

# Check if dependencies are installed
if ! "$PYTHON" -c "import faster_whisper" 2>/dev/null; then
    echo "Installing dependencies..."
    "$PYTHON" -m pip install faster-whisper sounddevice numpy httpx pywebview
fi

# Run the app
exec "$PYTHON" -m src.app "$@"
