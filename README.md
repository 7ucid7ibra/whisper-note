# WhisperNote

A floating voice-to-text pad that runs on your computer. Press a button or use a keyboard shortcut to start recording, and your speech instantly converts to text.

![WhisperNote Screenshot](screenshot.png)

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

### Step 3: Run the setup command

```bash
# Navigate to where you extracted the zip
cd /path/to/whisper-note

# Run the automatic setup
python setup.py
```

That's it! The setup will:
- Check your Python version
- Install all required dependencies
- Create a convenient run script

### Step 4: Start the app

```bash
# macOS
./run.sh

# Windows
run.bat
```

## First Time Setup

The first time you run WhisperNote, it will download the Whisper AI model (about 150MB for the "small" model). This happens automatically - just wait a bit on the first run.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Cmd+A` (Mac) / `Ctrl+Alt+A` (Windows) | Start/stop recording |
| `Space` | Pause/resume while recording |
| `Enter` | Stop and transcribe |

## Troubleshooting

### "python: command not found"
Install Python from [python.org](https://www.python.org/) (version 3.8 or newer).

### "No audio device found"
Make sure your microphone is connected and enabled in your system settings.

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