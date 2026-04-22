# WhisperNote - Agent Briefing

## Project Overview

**WhisperNote** is a floating voice-to-text desktop application that runs on macOS and Windows. Users click a microphone button or press a keyboard shortcut to record voice, which is instantly transcribed to text using Whisper AI (either locally or via a remote server).

## Tech Stack

- **Backend**: Python 3.11+ with PyObjC
- **Frontend**: Vanilla HTML/CSS/JS (webview)
- **Framework**: pywebview (wraps webview in native window)
- **AI**: faster-whisper (local) or remote Whisper server
- **Audio**: sounddevice, soundfile, scipy for audio processing
- **Database**: SQLite for transcription history
- **Build**: PyInstaller for packaging

## Key Features

### Recording & Transcription
- Click mic button or press `Ctrl+Cmd+A` (Mac) / `Ctrl+Alt+A` (Windows) to start/stop recording
- Press `Space` to pause/resume during recording
- Press `Enter` to stop and transcribe immediately
- Audio is captured at 16kHz mono WAV for Whisper compatibility

### Local vs Remote Transcription
- **Local**: Uses faster-whisper (runs offline, downloads model on first use)
- **Remote**: Connects to a Whisper server (IP:port) - useful for faster transcription
- Settings allow toggling between hosted/local and configuring fallback options

### Transcription Metadata
Every transcription saved to SQLite includes:
- `created_at` - timestamp
- `text` - transcribed content
- `source` - "local:model" or "remote:ip:port:model"
- `duration_ms` - how long transcription took (milliseconds)
- `model` - which Whisper model was used
- `is_local` - 1 for local, 0 for remote

### Drag & Drop Audio Files
Users can drag audio files (wav, mp3, m4a, flac, ogg, aiff) onto the window to transcribe them without recording. The file is read as bytes in JavaScript, passed to Python, converted to 16kHz WAV if needed, then transcribed.

### History
All transcriptions are saved to `data/transcriptions.db` and persist across sessions.

## Architecture

### File Structure
```
whisper-note/
├── src/app.py           # Main Python application
├── ui/
│   ├── index.html      # Main HTML
│   ├── app.js          # Frontend JavaScript
│   └── style.css       # Frontend CSS
├── scripts/
│   └── build_macos_release.sh  # DMG build script
├── data/               # SQLite database (created at runtime)
├── dist/               # Built app bundles
└── requirements.txt    # Python dependencies
```

### Python Backend (src/app.py)
- `WhisperNoteAPI` class exposes functions to JavaScript via pywebview
- Recording handled in Python using sounddevice (real-time audio capture)
- Transcription routes to either local faster-whisper or remote HTTP API
- Events emitted to JS via `window.__onPythonEvent()`

### JavaScript Frontend (ui/app.js)
- Handles UI interactions (mic button, settings, keyboard shortcuts)
- Receives events from Python and updates UI accordingly
- Drag-and-drop handlers for file transcription
- Sound effects using Web Audio API

## Build Process

### macOS DMG Build
```bash
./scripts/build_macos_release.sh
```

The script:
1. Runs PyInstaller to create `WhisperNote.app` bundle
2. Strips ALL code signatures (no Developer ID = no "damaged app" error)
3. Packages into `dist/WhisperNote-macOS.dmg`

### Installation (No Developer Account)
Since the app is unsigned, users must:
1. Download DMG from releases
2. Double-click to mount
3. Drag app to Applications
4. Run in Terminal: `sudo xattr -rd com.apple.quarantine "/Applications/WhisperNote.app"`
5. Double-click app to run

## Known Issues

### UI Freeze in Packaged App
There was a bug where the packaged app's UI became completely unresponsive (couldn't click anything). The fix was using `{ passive: false }` on drag event listeners and attaching them to `document` instead of `document.body`. This prevents the browser/webview from treating drag events as scroll-related.

### "Damaged App" Error
When PyInstaller builds the app, it adds an ad-hoc code signature. macOS treats this as "damaged/corrupted" for unsigned apps. The fix is to run `codesign --remove-signature` on all files in the staging directory BEFORE creating the DMG.

### Drag-and-Drop in webview
The `file.path` property is not available in pywebview's webview. File content must be read as ArrayBuffer in JavaScript and passed as a byte array to Python.

## Recent Changes (2026-04-21)

1. **DMG Distribution**: Added DMG installer option for easy sharing without Python
2. **Code Signing Fix**: Removed signatures to prevent "damaged app" error
3. **Drag-and-Drop**: Added ability to drop audio files to transcribe
4. **Transcription Metadata**: Added duration_ms, model, and is_local fields to database
5. **GUI Position Fix**: Fixed window position shift when dragging files
6. **M4A Support**: Already included in supported formats

## Running Locally for Development

```bash
# Activate virtual environment
source .venv/bin/activate

# Run the app
python -m src.app

# Or use the wrapper script
./run.sh
```

## Database Schema

```sql
CREATE TABLE transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    duration_ms INTEGER,
    model TEXT,
    is_local INTEGER DEFAULT 0
);
```

Query examples:
```bash
# View recent transcriptions with metadata
sqlite3 ~/Library/Application\ Support/WhisperNote/transcriptions.db "SELECT created_at, duration_ms, model, is_local, substr(text, 1, 50) FROM transcriptions ORDER BY id DESC LIMIT 10"
```

## Release Process

1. Make code changes
2. Test locally with `python -m src.app`
3. Build DMG: `./scripts/build_macos_release.sh`
4. Verify app is unsigned: `codesign --verify -vvv dist/WhisperNote.app`
5. Commit changes: `git add -A && git commit -m "description"`
6. Push: `git push`
7. Upload to GitHub release: `gh release upload v1.0.0 dist/WhisperNote-macOS.dmg --clobber`

## Important Files for Understanding

- `src/app.py:1-50` - Imports and constants
- `src/app.py:200-300` - Recording functionality
- `src/app.py:570-630` - Transcription routing (local vs remote)
- `src/app.py:680-750` - File transcription (drag-drop)
- `ui/app.js:350-400` - Mic button and keyboard shortcuts
- `ui/app.js:600-650` - Drag-and-drop handlers
- `scripts/build_macos_release.sh:80-100` - Signature removal
