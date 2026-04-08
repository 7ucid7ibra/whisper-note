#!/usr/bin/env bash
# Run whisper-note using the shared layer3 virtual environment.
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/../3layer-rag/.venv"

if [ ! -d "$VENV" ]; then
  echo "venv not found at $VENV"
  exit 1
fi

source "$VENV/bin/activate"
cd "$DIR"
exec python -m src.app "$@"
