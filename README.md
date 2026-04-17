# WhisperNote

A floating voice-to-text pad that runs on your computer. Press a button or use a keyboard shortcut to start recording, and your speech instantly converts to text.

## What It Does

- **Record voice notes** by clicking the microphone button or pressing `Ctrl+Cmd+A`
- **Instant transcription** using local Whisper AI (works offline!)
- **Floating window** that stays on top of other apps
- **History** of all your transcriptions saved automatically

## Quick Start (2 minutes)

### Step 1: Download the code

Click the green **Code** button on this page, then click **Download ZIP**.

### Step 2: Open your terminal

**macOS:**
- Press `Cmd+Space`, type `Terminal`, press `Enter`

**Windows:**
- Press `Win+R`, type `cmd`, press `Enter`

### Step 3: Run one command

```bash
# Navigate to where you extracted the zip
cd /path/to/whisper-note

# macOS
./run.sh

# Windows
run.bat
```

That's it! On first run, it will automatically:
1. Check for Python (prompt you to install if missing)
2. Install all required dependencies
3. Start the app


## macOS Release Build

To build an app bundle and DMG on macOS:

```bash
./scripts/build_macos_release.sh
```

The script:
- builds `WhisperNote.app` with the custom icon from `assets/WhisperNote.icns`
- bundles the UI into the app so it runs from the `.app` bundle
- creates a DMG in `dist/WhisperNote-macOS.dmg`

## First Time Setup

The first time you run WhisperNote, it will download the Whisper AI model (about 150MB for the "small" model). This happens automatically - just wait a bit on the first run.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Cmd+A` (Mac) / `Ctrl+Alt+A` (Windows) | Start/stop recording |
| `Space` | Pause/resume while recording |
| `Enter` | Stop and transcribe |

## Troubleshooting

### "Python not found"
Install Python from [python.org](https://www.python.org/) (version 3.8 or newer). Make sure to check "Add Python to PATH" on Windows.

### "No audio device found"
Make sure your microphone is connected and enabled in your system settings. On macOS, WhisperNote also needs Microphone permission in `System Settings > Privacy & Security > Microphone`. If the app still does not appear there, reset the Microphone permission and reopen WhisperNote.

### App won't start
Try running from terminal to see error messages:
```bash
python -m src.app
```

## System Requirements

- **macOS 10.15+** or **Windows 10+**
- **Python 3.8+**
- **Microphone** (built-in or external)
- **Internet** (first time only, to download AI model)

## License

MIT