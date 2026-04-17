# WhisperNote Change Log

## 2026-04-17

Updated WhisperNote across UI, transcription routing, persistence, and startup/shutdown behavior.

- Added an info button in the title area with a short hover help card for shortcuts and usage tips.
- Removed the always-visible mic shortcut hint and kept the shortcut guidance in the info popup.
- Reworked transcription settings to use separate toggles for hosted Whisper and local fallback.
- Added per-host model selection for the primary server, fallback server, and local Whisper.
- Persisted successful transcriptions to a local SQLite database in `data/transcriptions.db`.
- Improved shutdown so the close animation plays cleanly and the app exits more reliably.
- Tightened global hotkey setup so macOS listen-event permission is requested and logged explicitly.
- Updated `run.sh` to prefer the shared `3layer-rag` virtual environment from this workspace and print the selected Python runtime.

