"""WhisperNote — floating voice-to-text pad. No LLM, no memory."""
from __future__ import annotations

import base64
import multiprocessing
import io
import json
import logging
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

# Prevent libiomp5 crash on macOS with torch + ctranslate2
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import webview

log = logging.getLogger(__name__)

APP_NAME = "WhisperNote"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return PROJECT_ROOT


def _data_root() -> Path:
    if getattr(sys, "frozen", False):
        if sys.platform == "darwin":
            return Path.home() / "Library" / "Application Support" / APP_NAME
        if sys.platform == "win32":
            base = Path(os.environ.get("LOCALAPPDATA", Path.home()))
            return base / APP_NAME
        return Path.home() / f".{APP_NAME.lower()}"
    return PROJECT_ROOT / "data"


DATA_DIR      = _data_root()
ENV_PATH      = DATA_DIR / ".env"
GEOMETRY_PATH = DATA_DIR / "window_geometry.json"
DB_PATH       = DATA_DIR / "transcriptions.db"

_ENV_WHISPER               = "WHISPER_MODEL"
_ENV_TRANSCRIBER_IP        = "TRANSCRIBER_IP"
_ENV_TRANSCRIBER_PORT      = "TRANSCRIBER_PORT"
_ENV_TRANSCRIBER_FALLBACK_IP   = "TRANSCRIBER_FALLBACK_IP"
_ENV_TRANSCRIBER_FALLBACK_PORT = "TRANSCRIBER_FALLBACK_PORT"
_ENV_TRANSCRIBER_MODEL = "TRANSCRIBER_MODEL"
_ENV_TRANSCRIBER_FALLBACK_MODEL = "TRANSCRIBER_FALLBACK_MODEL"
_ENV_ALWAYS_ON_TOP = "ALWAYS_ON_TOP"
_ENV_USE_HOSTED_WHISPER = "USE_HOSTED_WHISPER"
_ENV_USE_LOCAL_FALLBACK = "USE_LOCAL_FALLBACK"
_ENV_LOCAL_WHISPER_MODEL = "LOCAL_WHISPER_MODEL"
_ENV_TRANSCRIPTION_LANGUAGE = "TRANSCRIPTION_LANGUAGE"
# Legacy key retained for backward-compat defaults only.
_ENV_FORCE_LOCAL   = "FORCE_LOCAL"

# ── Recording state (module-level so callbacks can reach it) ──────────────────
_SAMPLE_RATE = 16000
_BLOCK_SIZE  = 800          # ~50 ms per callback at 16 kHz

_rec_lock   = threading.Lock()
_rec_active = False
_rec_paused = False
_rec_frames: list = []      # list of numpy int16 arrays
_rec_stream = None          # sounddevice.InputStream

# ── Whisper cache ─────────────────────────────────────────────────────────────
_whisper_cache: dict = {}
_whisper_lock = threading.Lock()


def _load_whisper(model_size: str = "small"):
    with _whisper_lock:
        if model_size in _whisper_cache:
            return _whisper_cache[model_size] or None
        try:
            import contextlib, warnings
            buf = io.StringIO()
            with contextlib.redirect_stderr(buf), warnings.catch_warnings():
                warnings.simplefilter("ignore")
                from faster_whisper import WhisperModel
                log.info("Loading Whisper %s…", model_size)
                model = WhisperModel(model_size, device="cpu", compute_type="int8")
            _whisper_cache[model_size] = model
            log.info("Whisper %s ready", model_size)
            return model
        except Exception as e:
            log.warning("Whisper load failed (%s): %s", model_size, e)
            _whisper_cache[model_size] = False
            return None


def _shutdown_whisper_cache() -> None:
    with _whisper_lock:
        if _whisper_cache:
            _whisper_cache.clear()


# ── Env helpers ───────────────────────────────────────────────────────────────

def load_env() -> dict:
    if not ENV_PATH.exists():
        return {}
    result: dict[str, str] = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        result[k.strip()] = v.strip().strip('"').strip("'")
    return result


def save_env(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    lines = [f"{k}={v}" for k, v in data.items() if v is not None]
    ENV_PATH.write_text("\n".join(lines) + "\n")


def _as_bool(value: str | bool | None, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _derive_transcription_toggles(env: dict) -> tuple[bool, bool]:
    """Resolve hosted/local toggles from current env with legacy fallback."""
    hosted_raw = env.get(_ENV_USE_HOSTED_WHISPER)
    local_raw = env.get(_ENV_USE_LOCAL_FALLBACK)
    if hosted_raw is not None or local_raw is not None:
        return _as_bool(hosted_raw, True), _as_bool(local_raw, True)

    force_local = _as_bool(env.get(_ENV_FORCE_LOCAL), False)
    if force_local:
        return False, True
    return True, True


def _get_local_whisper_model(env: dict) -> str:
    model = str(env.get(_ENV_LOCAL_WHISPER_MODEL) or env.get(_ENV_WHISPER) or "small").strip()
    return model or "small"


def _get_remote_whisper_model(env: dict, fallback: bool) -> str:
    key = _ENV_TRANSCRIBER_FALLBACK_MODEL if fallback else _ENV_TRANSCRIBER_MODEL
    model = str(env.get(key) or "medium").strip()
    return model or "medium"


def _init_transcription_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS transcriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                text TEXT NOT NULL,
                source TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions(created_at)"
        )
        conn.commit()


# ── Remote transcription ──────────────────────────────────────────────────────

def _transcribe_remote(ip: str, port: int, wav_bytes: bytes, model_name: str = "",
                       language: str | None = None, timeout: float = 60.0) -> str | None:
    """POST WAV to remote ASR server, return transcribed text or None."""
    if not ip or not wav_bytes:
        return None
    try:
        import httpx
        url = f"http://{ip}:{int(port)}/asr"
        payload = {"output": "json"}
        if language and language != "auto":
            payload["language"] = language
        if model_name:
            payload["model"] = model_name
        with httpx.Client(timeout=timeout) as c:
            r = c.post(
                url,
                data=payload,
                files={"audio_file": ("audio.wav", wav_bytes, "audio/wav")},
            )
        if r.status_code != 200:
            log.debug("Remote ASR %s: HTTP %d", url, r.status_code)
            return None
        text = r.text.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                segs = parsed.get("segments", parsed.get("words", []))
            elif isinstance(parsed, list):
                segs = parsed
            else:
                return text
            if isinstance(segs, list):
                parts = [str(s.get("text", "")).strip() for s in segs if s.get("text")]
                return " ".join(parts).strip() or None
        except Exception:
            return text or None
    except Exception as e:
        log.debug("Remote ASR failed: %s", e)
        return None


# ── Main API class ────────────────────────────────────────────────────────────

class WhisperNoteAPI:
    """Exposed to JS via window.pywebview.api.*"""

    def __init__(self) -> None:
        self._window = None

    def set_window(self, window) -> None:
        self._window = window

    def _emit(self, event: str, data=None) -> None:
        if not self._window:
            return
        payload = json.dumps({"event": event, "data": data})
        self._window.evaluate_js(f"window.__onPythonEvent({json.dumps(payload)})")

    # ── Recording API (called from JS button and global hotkey) ───────────────

    def toggle_recording(self) -> None:
        """Start recording, or stop-and-transcribe if already recording."""
        global _rec_active
        with _rec_lock:
            if _rec_active:
                self._do_stop(discard=False)
            else:
                self._do_start()

    def pause_recording(self) -> None:
        """Toggle pause/resume while recording."""
        global _rec_paused
        with _rec_lock:
            if not _rec_active:
                return
            _rec_paused = not _rec_paused
            self._emit("recording_paused" if _rec_paused else "recording_resumed", None)

    def discard_recording(self) -> None:
        """Stop recording and throw away the audio without transcribing."""
        with _rec_lock:
            if _rec_active:
                self._do_stop(discard=True)

    def _do_start(self) -> None:
        global _rec_active, _rec_paused, _rec_frames, _rec_stream
        import sounddevice as sd
        import numpy as np

        _rec_active = True
        _rec_paused = False
        _rec_frames = []
        api_ref = self

        def _callback(indata, frames, time_info, status):
            if not _rec_paused:
                _rec_frames.append(indata.copy())
            rms = float(np.sqrt(np.mean(indata.astype(np.float64) ** 2)))
            level = round(min(1.0, rms / 4000.0), 3)
            api_ref._emit("audio_level", level)

        _rec_stream = sd.InputStream(
            samplerate=_SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=_BLOCK_SIZE,
            callback=_callback,
        )
        _rec_stream.start()
        self._emit("recording_started", None)
        log.info("Recording started")

    def _do_stop(self, discard: bool = False) -> None:
        global _rec_active, _rec_paused, _rec_stream, _rec_frames
        _rec_active = False
        _rec_paused = False
        stream = _rec_stream
        frames = _rec_frames[:]
        _rec_stream = None
        _rec_frames = []

        if stream:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass

        if discard:
            self._emit("recording_discarded", None)
            log.info("Recording discarded")
            return

        self._emit("recording_stopped", None)
        log.info("Recording stopped — %d blocks captured", len(frames))
        threading.Thread(
            target=self._transcribe_frames,
            args=(frames,),
            daemon=True,
        ).start()

    def _transcribe_frames(self, frames: list) -> None:
        import numpy as np

        if not frames:
            self._emit("transcription_error", "nothing heard")
            return

        self._emit("transcription_start", None)

        # Build WAV bytes from raw int16 frames
        try:
            audio_np = np.concatenate(frames, axis=0)
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)   # int16
                wf.setframerate(_SAMPLE_RATE)
                wf.writeframes(audio_np.tobytes())
            wav_bytes = buf.getvalue()
        except Exception as e:
            log.warning("Failed to build WAV from frames: %s", e)
            self._emit("transcription_error", "audio error")
            return

        text, source = self._transcribe_wav_bytes(wav_bytes)
        if text:
            self._save_transcription(text, source)
            self._emit("transcription_result", text)
        else:
            self._emit("transcription_error", "nothing heard")

    def _transcribe_wav_bytes(self, wav_bytes: bytes) -> tuple[str, str]:
        """Route hosted/local ASR based on settings and return (text, source)."""
        env = load_env()
        use_hosted_whisper, use_local_fallback = _derive_transcription_toggles(env)
        transcription_lang = env.get(_ENV_TRANSCRIPTION_LANGUAGE, "auto")

        if use_hosted_whisper:
            for key_ip, key_port, fallback_flag in [
                (_ENV_TRANSCRIBER_IP,          _ENV_TRANSCRIBER_PORT, False),
                (_ENV_TRANSCRIBER_FALLBACK_IP,  _ENV_TRANSCRIBER_FALLBACK_PORT, True),
            ]:
                ip = (env.get(key_ip) or "").strip()
                try:
                    port = int(env.get(key_port, "9000"))
                except (ValueError, TypeError):
                    port = 9000
                if ip:
                    remote_model = _get_remote_whisper_model(env, fallback_flag)
                    text = _transcribe_remote(
                        ip, port, wav_bytes, model_name=remote_model,
                        language=transcription_lang if transcription_lang != "auto" else None,
                        timeout=60.0
                    )
                    if text:
                        log.info("Remote ASR (%s): %s", ip, text[:100])
                        return text, f"remote:{ip}:{port}:{remote_model}"

        if not use_local_fallback:
            return "", ""

        # Local Whisper fallback (or primary if hosted is disabled)
        model_size = _get_local_whisper_model(env)
        model = _load_whisper(model_size)
        if model is None:
            return "", ""
        tmp = Path(tempfile.mktemp(suffix=".wav"))
        try:
            tmp.write_bytes(wav_bytes)
            lang_arg = None if transcription_lang == "auto" else transcription_lang
            segments, _ = model.transcribe(str(tmp), language=lang_arg)
            text = " ".join(seg.text for seg in segments).strip()
            log.info("Local Whisper: %s", text[:100])
            return text, f"local:{model_size}"
        except Exception as e:
            log.warning("Local transcribe failed: %s", e)
            return "", ""
        finally:
            tmp.unlink(missing_ok=True)

    def _save_transcription(self, text: str, source: str) -> None:
        if not text.strip():
            return
        created_at = datetime.now(timezone.utc).isoformat()
        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    "INSERT INTO transcriptions (created_at, text, source) VALUES (?, ?, ?)",
                    (created_at, text.strip(), source or "unknown"),
                )
                conn.commit()
        except Exception as e:
            log.warning("Failed to save transcription: %s", e)

    # ── Settings ──────────────────────────────────────────────────────────────

    def get_settings(self) -> dict:
        env = load_env()
        use_hosted_whisper, use_local_fallback = _derive_transcription_toggles(env)
        return {
            "local_whisper_model":      _get_local_whisper_model(env),
            "transcriber_ip":           env.get(_ENV_TRANSCRIBER_IP, ""),
            "transcriber_port":         env.get(_ENV_TRANSCRIBER_PORT, "9000"),
            "transcriber_model":        _get_remote_whisper_model(env, False),
            "transcriber_fallback_ip":  env.get(_ENV_TRANSCRIBER_FALLBACK_IP, ""),
            "transcriber_fallback_port": env.get(_ENV_TRANSCRIBER_FALLBACK_PORT, "9000"),
            "transcriber_fallback_model": _get_remote_whisper_model(env, True),
            "always_on_top": env.get(_ENV_ALWAYS_ON_TOP, "true").lower() != "false",
            "use_hosted_whisper": use_hosted_whisper,
            "use_local_fallback": use_local_fallback,
            "transcription_language": env.get(_ENV_TRANSCRIPTION_LANGUAGE, "auto"),
        }

    def save_settings(self, data: dict) -> None:
        env = load_env()
        if "local_whisper_model" in data:
            local_model = str(data["local_whisper_model"]).strip() or "small"
            env[_ENV_LOCAL_WHISPER_MODEL] = local_model
            # Keep legacy key in sync for backward compatibility.
            env[_ENV_WHISPER] = local_model
        if "transcriber_ip" in data:
            env[_ENV_TRANSCRIBER_IP] = str(data["transcriber_ip"]).strip() or ""
        if "transcriber_port" in data:
            env[_ENV_TRANSCRIBER_PORT] = str(data["transcriber_port"]).strip() or "9000"
        if "transcriber_model" in data:
            env[_ENV_TRANSCRIBER_MODEL] = str(data["transcriber_model"]).strip() or "medium"
        if "transcriber_fallback_ip" in data:
            env[_ENV_TRANSCRIBER_FALLBACK_IP] = str(data["transcriber_fallback_ip"]).strip() or ""
        if "transcriber_fallback_port" in data:
            env[_ENV_TRANSCRIBER_FALLBACK_PORT] = str(data["transcriber_fallback_port"]).strip() or "9000"
        if "transcriber_fallback_model" in data:
            env[_ENV_TRANSCRIBER_FALLBACK_MODEL] = (
                str(data["transcriber_fallback_model"]).strip() or "medium"
            )
        if "always_on_top" in data:
            env[_ENV_ALWAYS_ON_TOP] = "true" if data["always_on_top"] else "false"
            self._apply_on_top(bool(data["always_on_top"]))
        if "use_hosted_whisper" in data:
            env[_ENV_USE_HOSTED_WHISPER] = "true" if data["use_hosted_whisper"] else "false"
        if "use_local_fallback" in data:
            env[_ENV_USE_LOCAL_FALLBACK] = "true" if data["use_local_fallback"] else "false"
        if "transcription_language" in data:
            lang = str(data["transcription_language"]).strip()
            if lang in ("auto", "en", "de"):
                env[_ENV_TRANSCRIPTION_LANGUAGE] = lang
            else:
                env[_ENV_TRANSCRIPTION_LANGUAGE] = "auto"

        use_hosted_whisper, use_local_fallback = _derive_transcription_toggles(env)
        if not use_hosted_whisper and not use_local_fallback:
            raise ValueError("Enable hosted or local transcription.")
        save_env(env)

    def _apply_on_top(self, enabled: bool) -> None:
        try:
            from webview.platforms import cocoa
            if self._window:
                cocoa.set_on_top(self._window.uid, enabled)
        except Exception as e:
            log.warning("set_on_top failed: %s", e)

    # ── Window ────────────────────────────────────────────────────────────────

    def close_window(self) -> None:
        self._do_close()

    def _save_geometry(self) -> None:
        if not self._window:
            return
        try:
            geom: dict = {"width": self._window.width, "height": self._window.height}
            x = getattr(self._window, "x", None)
            y = getattr(self._window, "y", None)
            if x is not None:
                geom["x"] = x
            if y is not None:
                geom["y"] = y
            GEOMETRY_PATH.write_text(json.dumps(geom))
        except Exception:
            pass

    def _do_close(self) -> None:
        self._save_geometry()
        _teardown_global_hotkey()
        try:
            if self._window:
                # Ensure window teardown runs on Cocoa main thread.
                from PyObjCTools import AppHelper
                AppHelper.callAfter(self._window.destroy)
        except Exception:
            try:
                if self._window:
                    self._window.destroy()
            except Exception:
                pass


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _load_geometry() -> dict:
    try:
        return json.loads(GEOMETRY_PATH.read_text())
    except Exception:
        return {}


# ── Global hotkey ─────────────────────────────────────────────────────────────
# Kept at module level so GC never collects the NSEvent monitor object.
_hotkey_monitor = None
_hotkey_perm_warned = False


def _ensure_global_hotkey_permission(prompt: bool = True) -> bool:
    """Return True if macOS keyboard-listen permission is available."""
    try:
        from Quartz import CGPreflightListenEventAccess, CGRequestListenEventAccess
    except Exception as e:
        # If API is unavailable, keep legacy behavior.
        log.debug("Hotkey permission API unavailable: %s", e)
        return True

    try:
        if CGPreflightListenEventAccess():
            return True
        if prompt:
            try:
                granted_now = bool(CGRequestListenEventAccess())
                if granted_now:
                    return True
            except Exception as e:
                log.debug("Hotkey permission request failed: %s", e)
        return bool(CGPreflightListenEventAccess())
    except Exception as e:
        log.debug("Hotkey permission preflight failed: %s", e)
        return True


def _setup_global_hotkey(window, api: WhisperNoteAPI) -> None:  # noqa: ARG001
    """Register ⌃⌘A as a global hotkey.

    Called from window.events.loaded (a background thread).
    NSEvent monitor registration must happen on the Cocoa main thread, so we
    schedule it with AppHelper.callAfter.  The result is stored in
    _hotkey_monitor to prevent GC from destroying the ObjC block.
    """
    global _hotkey_monitor, _hotkey_perm_warned
    try:
        from AppKit import (
            NSEvent,
            NSEventMaskKeyDown,
            NSEventModifierFlagCommand,
            NSEventModifierFlagControl,
            NSEventModifierFlagOption,
            NSEventModifierFlagShift,
        )
        from PyObjCTools import AppHelper

        _CMD = int(NSEventModifierFlagCommand)
        _CTRL = int(NSEventModifierFlagControl)
        _OPT = int(NSEventModifierFlagOption)
        _SHFT = int(NSEventModifierFlagShift)
        _A = 0  # kVK_ANSI_A

        def _on_key(event):
            try:
                flags = int(event.modifierFlags())
                if (
                    event.keyCode() == _A
                    and (flags & _CMD)
                    and (flags & _CTRL)
                    and not (flags & _OPT)
                    and not (flags & _SHFT)
                ):
                    # Call Python recording directly — no JS or evaluate_js needed.
                    # Spawn a thread so we don't block the Cocoa event queue.
                    log.debug("Global hotkey detected: ⌃⌘A")
                    threading.Thread(target=api.toggle_recording, daemon=True).start()
            except Exception:
                pass

        def _register():
            global _hotkey_monitor
            _hotkey_monitor = NSEvent.addGlobalMonitorForEventsMatchingMask_handler_(
                int(NSEventMaskKeyDown),
                _on_key,
            )
            log.info("Global hotkey ready: ⌃⌘A")

        permission_ok = _ensure_global_hotkey_permission(prompt=True)
        if not permission_ok and not _hotkey_perm_warned:
            _hotkey_perm_warned = True
            log.warning(
                "Global hotkey permission not granted for this runtime (%s). "
                "Enable Input Monitoring/Accessibility for your terminal/IDE and restart.",
                sys.executable,
            )

        AppHelper.callAfter(_register)

    except Exception as e:
        log.warning("Global hotkey setup failed (window-focus shortcut still works): %s", e)


def _teardown_global_hotkey() -> None:
    global _hotkey_monitor
    if _hotkey_monitor is None:
        return
    try:
        from AppKit import NSEvent
        NSEvent.removeMonitor_(_hotkey_monitor)
    except Exception as e:
        log.debug("Global hotkey teardown failed: %s", e)
    finally:
        _hotkey_monitor = None


def _graceful_shutdown_or_force_exit(timeout_s: float = 1.5) -> None:
    """Try graceful shutdown; force-exit if non-daemon threads keep process alive."""
    _teardown_global_hotkey()
    _shutdown_whisper_cache()

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        alive = [
            t for t in threading.enumerate()
            if t is not threading.main_thread() and t.is_alive() and not t.daemon
        ]
        if not alive:
            return
        time.sleep(0.05)

    lingering = [
        t.name for t in threading.enumerate()
        if t is not threading.main_thread() and t.is_alive() and not t.daemon
    ]
    if lingering:
        log.warning("Forcing exit; lingering non-daemon threads: %s", ", ".join(lingering))
        logging.shutdown()
        os._exit(0)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _init_transcription_db()
    log_path = DATA_DIR / "whisper-note.log"
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(str(log_path), mode="w", encoding="utf-8"),
        ],
    )
    log.info("=== whisper-note starting ===")

    api = WhisperNoteAPI()

    # Pre-warm Whisper in background so the first transcription is instant
    env = load_env()
    threading.Thread(
        target=_load_whisper,
        args=(_get_local_whisper_model(env),),
        daemon=True,
    ).start()

    on_top = env.get(_ENV_ALWAYS_ON_TOP, "true").lower() != "false"

    geom = _load_geometry()
    w = geom.get("width",  340)
    h = geom.get("height", 560)
    x = geom.get("x")
    y = geom.get("y")
    # Discard positions from disconnected monitors (pywebview crashes on None screen)
    if x is not None and y is not None:
        if x < -100 or y < -100 or x > 16000 or y > 16000:
            x = None
            y = None

    ui_dir = _resource_root() / "ui"

    window = webview.create_window(
        "whisper note",
        url=str(ui_dir / "index.html"),
        js_api=api,
        width=w,
        height=h,
        x=x,
        y=y,
        frameless=True,
        on_top=on_top,
        transparent=True,
        resizable=True,
        min_size=(260, 340),
    )
    api.set_window(window)

    window.events.loaded += lambda: _setup_global_hotkey(window, api)

    try:
        webview.start(debug=False)
    except Exception:
        log.exception("webview.start() raised an exception")
        raise
    log.info("=== whisper-note exited cleanly ===")
    _graceful_shutdown_or_force_exit()
    sys.exit(0)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
