#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This release script only runs on macOS."
  exit 1
fi

APP_NAME="WhisperNote"
ICON_FILE="$ROOT/assets/WhisperNote.icns"
UI_DIR="$ROOT/ui"
SRC_FILE="$ROOT/src/app.py"
BUILD_ROOT="$ROOT/build/release"
PYI_BUILD="$BUILD_ROOT/pyinstaller"
PYI_SPEC="$BUILD_ROOT/spec"
DIST_DIR="$ROOT/dist"
STAGING_DIR="$BUILD_ROOT/dmg-staging"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
DMG_FILE="$DIST_DIR/$APP_NAME-macOS.dmg"

if [[ ! -f "$ICON_FILE" ]]; then
  echo "Missing icon: $ICON_FILE"
  exit 1
fi

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for candidate in \
    "$ROOT/.venv/bin/python" \
    "$ROOT/.venv/bin/python3" \
    "$(command -v python3 || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      PYTHON="$candidate"
      break
    fi
  done
fi

if [[ -z "$PYTHON" || ! -x "$PYTHON" ]]; then
  echo "No usable Python interpreter found."
  exit 1
fi

echo "Using Python: $PYTHON"
"$PYTHON" -m pip install --upgrade pip >/dev/null
"$PYTHON" -m pip install --upgrade -r requirements.txt pyinstaller >/dev/null
"$PYTHON" -m pip install --upgrade pyobjc-framework-AVFoundation >/dev/null

rm -rf "$BUILD_ROOT" "$DIST_DIR"
mkdir -p "$PYI_BUILD" "$PYI_SPEC" "$DIST_DIR" "$STAGING_DIR"

"$PYTHON" -m PyInstaller \
  --noconfirm \
  --clean \
  --windowed \
  --name "$APP_NAME" \
  --icon "$ICON_FILE" \
  --osx-bundle-identifier "com.whispernote.app" \
  --add-data "$UI_DIR:ui" \
  --collect-all webview \
  --collect-all faster_whisper \
  --collect-all sounddevice \
  --collect-all numpy \
  --collect-all httpx \
  --collect-all objc \
  --collect-all AVFoundation \
  --collect-all pyobjc_framework_AVFoundation \
  --distpath "$DIST_DIR" \
  --workpath "$PYI_BUILD" \
  --specpath "$PYI_SPEC" \
  "$SRC_FILE"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "PyInstaller did not produce: $APP_BUNDLE"
  exit 1
fi

PLIST="$APP_BUNDLE/Contents/Info.plist"
MICROPHONE_DESC="WhisperNote needs microphone access to record and transcribe voice notes."
if /usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription $MICROPHONE_DESC" "$PLIST"
else
  /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string $MICROPHONE_DESC" "$PLIST"
fi

for f in $(find "$APP_BUNDLE" -type f); do
  codesign --remove-signature "$f" 2>/dev/null || true
done

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$APP_BUNDLE" "$STAGING_DIR/$APP_NAME.app"
codesign --remove-signature "$STAGING_DIR/$APP_NAME.app" 2>/dev/null || true
ln -s /Applications "$STAGING_DIR/Applications"

rm -f "$DMG_FILE"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_FILE"

echo "Built app bundle: $APP_BUNDLE"
echo "Built DMG: $DMG_FILE"
