# WhisperNote Change Log

## 2026-04-21

Added DMG distribution, drag-and-drop file transcription, and transcription metadata tracking.

- Added "Option B" DMG installation instructions for macOS - download, drag to Applications, run one allowlist command, done.
- Fixed "damaged app" error in unsigned DMG builds by removing code signing from the build script.
- Added drag-and-drop audio file transcription - drop wav, mp3, m4a, flac, ogg, or aiff files onto the window to transcribe.
- Added transcription metadata to database: duration_ms (transcription time), model (Whisper model used), is_local (local vs remote).
- Fixed GUI position shift when dragging files onto the window.

## 2026-04-17

Updated WhisperNote across UI, transcription routing, persistence, startup/shutdown behavior, macOS release packaging, and frozen-app launch stability.

- Added an info button in the title area with a short hover help card for shortcuts and usage tips.
- Removed the always-visible mic shortcut hint and kept the shortcut guidance in the info popup.
- Reworked transcription settings to use separate toggles for hosted Whisper and local fallback.
- Added per-host model selection for the primary server, fallback server, and local Whisper.
- Persisted successful transcriptions to a local SQLite database in `data/transcriptions.db`.
- Improved shutdown so the close animation plays cleanly and the app exits more reliably.
- Tightened global hotkey setup so macOS listen-event permission is requested and logged explicitly.
- Updated `run.sh` to prefer the shared `3layer-rag` virtual environment from this workspace and print the selected Python runtime.
- Added a macOS release build script that packages `WhisperNote.app` with the custom icon and produces `dist/WhisperNote-macOS.dmg`.
- Added `multiprocessing.freeze_support()` so the frozen macOS bundle does not recursively spawn `resource_tracker` child processes.
- Added explicit macOS microphone permission handling, a startup microphone preflight, and a clearer error when recording cannot start.

