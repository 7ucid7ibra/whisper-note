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
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Prevent libiomp5 crash on macOS with torch + ctranslate2
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import webview

SUPPORTED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aiff", ".aif"}

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


DATA_DIR = _data_root()
ENV_PATH = DATA_DIR / ".env"
GEOMETRY_PATH = DATA_DIR / "window_geometry.json"
DB_PATH = DATA_DIR / "transcriptions.db"

_ENV_WHISPER = "WHISPER_MODEL"
_ENV_TRANSCRIBER_IP = "TRANSCRIBER_IP"
_ENV_TRANSCRIBER_PORT = "TRANSCRIBER_PORT"
_ENV_TRANSCRIBER_FALLBACK_IP = "TRANSCRIBER_FALLBACK_IP"
_ENV_TRANSCRIBER_FALLBACK_PORT = "TRANSCRIBER_FALLBACK_PORT"
_ENV_TRANSCRIBER_MODEL = "TRANSCRIBER_MODEL"
_ENV_TRANSCRIBER_FALLBACK_MODEL = "TRANSCRIBER_FALLBACK_MODEL"
_ENV_ALWAYS_ON_TOP = "ALWAYS_ON_TOP"
_ENV_USE_HOSTED_WHISPER = "USE_HOSTED_WHISPER"
_ENV_USE_LOCAL_FALLBACK = "USE_LOCAL_FALLBACK"
_ENV_LOCAL_WHISPER_MODEL = "LOCAL_WHISPER_MODEL"
_ENV_TRANSCRIPTION_LANGUAGE = "TRANSCRIPTION_LANGUAGE"
_ENV_HISTORY_WINDOW = "HISTORY_WINDOW"
# Legacy key retained for backward-compat defaults only.
_ENV_FORCE_LOCAL = "FORCE_LOCAL"

_HISTORY_WINDOWS: dict[str, timedelta | None] = {
    "all": None,
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
    "90d": timedelta(days=90),
}

# ── Recording state (module-level so callbacks can reach it) ──────────────────
_SAMPLE_RATE = 16000
_BLOCK_SIZE = 800  # ~50 ms per callback at 16 kHz

_rec_lock = threading.Lock()
_rec_active = False
_rec_paused = False
_rec_frames: list = []  # list of numpy int16 arrays
_rec_stream = None  # sounddevice.InputStream

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


# ── Mic permission ───────────────────────────────────────────────────────────

_mic_permission_request_in_flight = False


def _microphone_permission_status() -> str:
    """Return granted / denied / undetermined / unknown for macOS mic access."""
    if sys.platform != "darwin":
        return "granted"

    try:
        from AVFoundation import (
            AVCaptureDevice,
            AVAuthorizationStatusAuthorized,
            AVAuthorizationStatusDenied,
            AVAuthorizationStatusNotDetermined,
            AVAuthorizationStatusRestricted,
            AVMediaTypeAudio,
        )
    except Exception as e:
        log.debug("Microphone permission API unavailable: %s", e)
        return "unknown"

    try:
        status = int(AVCaptureDevice.authorizationStatusForMediaType_(AVMediaTypeAudio))
        if status == int(AVAuthorizationStatusAuthorized):
            return "granted"
        if status in (
            int(AVAuthorizationStatusDenied),
            int(AVAuthorizationStatusRestricted),
        ):
            return "denied"
        if status == int(AVAuthorizationStatusNotDetermined):
            return "undetermined"
    except Exception as e:
        log.debug("Microphone permission status check failed: %s", e)
        return "unknown"

    return "unknown"


def _request_microphone_permission_async(callback) -> bool:
    """Request macOS mic permission without blocking the caller."""
    if sys.platform != "darwin":
        callback(True)
        return True

    def _completion(granted):
        try:
            callback(bool(granted))
        except Exception as e:
            log.debug("Microphone permission callback failed: %s", e)

    # Prefer the newer AVAudioApplication API, but fall back to AVCaptureDevice
    # so older framework combinations still prompt correctly.
    try:
        from AVFoundation import AVAudioApplication

        AVAudioApplication.requestRecordPermissionWithCompletionHandler_(_completion)
        return True
    except Exception as e:
        log.debug("AVAudioApplication permission request unavailable: %s", e)

    try:
        from AVFoundation import AVCaptureDevice, AVMediaTypeAudio

        AVCaptureDevice.requestAccessForMediaType_completionHandler_(
            AVMediaTypeAudio, _completion
        )
        return True
    except Exception as e:
        log.debug("AVCaptureDevice permission request unavailable: %s", e)
        return False


def _preflight_microphone_permission() -> None:
    """Trigger the macOS prompt early so the app appears in Privacy settings."""
    if sys.platform != "darwin":
        return
    # Only needed when running as a frozen app bundle. When launched from the
    # terminal the TCC entry belongs to the terminal emulator, not the Python
    # interpreter, so this call would query the wrong process and may wrongly
    # show a permission prompt or block recording.
    if not getattr(sys, "frozen", False):
        return

    global _mic_permission_request_in_flight
    status = _microphone_permission_status()
    if status != "undetermined":
        log.info("Microphone permission status on launch: %s", status)
        return

    _mic_permission_request_in_flight = True
    log.info("Requesting macOS microphone permission on launch")

    def _on_result(granted: bool) -> None:
        global _mic_permission_request_in_flight
        _mic_permission_request_in_flight = False
        log.info("Microphone permission %s", "granted" if granted else "denied")

    if not _request_microphone_permission_async(_on_result):
        _mic_permission_request_in_flight = False
        log.debug("Microphone permission request could not be started")


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
    model = str(
        env.get(_ENV_LOCAL_WHISPER_MODEL) or env.get(_ENV_WHISPER) or "small"
    ).strip()
    return model or "small"


def _get_remote_whisper_model(env: dict, fallback: bool) -> str:
    key = _ENV_TRANSCRIBER_FALLBACK_MODEL if fallback else _ENV_TRANSCRIBER_MODEL
    model = str(env.get(key) or "medium").strip()
    return model or "medium"


def _normalize_history_window(value: str | None) -> str:
    key = str(value or "all").strip().lower()
    return key if key in _HISTORY_WINDOWS else "all"


def _get_history_window(env: dict) -> str:
    return _normalize_history_window(env.get(_ENV_HISTORY_WINDOW))


def _init_transcription_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS transcriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                text TEXT NOT NULL,
                source TEXT NOT NULL,
                duration_ms INTEGER,
                model TEXT,
                is_local INTEGER DEFAULT 0,
                favorite INTEGER DEFAULT 0
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions(created_at)"
        )
        # Migration: add new columns if they don't exist
        existing_columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(transcriptions)").fetchall()
        }
        if "duration_ms" not in existing_columns:
            conn.execute("ALTER TABLE transcriptions ADD COLUMN duration_ms INTEGER")
        if "model" not in existing_columns:
            conn.execute("ALTER TABLE transcriptions ADD COLUMN model TEXT")
        if "is_local" not in existing_columns:
            conn.execute(
                "ALTER TABLE transcriptions ADD COLUMN is_local INTEGER DEFAULT 0"
            )
        if "favorite" not in existing_columns:
            conn.execute(
                "ALTER TABLE transcriptions ADD COLUMN favorite INTEGER DEFAULT 0"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcriptions_favorite ON transcriptions(favorite)"
        )
        conn.commit()


def _row_to_transcription_dict(row) -> dict | None:
    if row is None:
        return None
    return {
        "id": int(row["id"]),
        "created_at": row["created_at"],
        "text": row["text"],
        "source": row["source"],
        "duration_ms": row["duration_ms"],
        "model": row["model"],
        "is_local": bool(row["is_local"]),
        "favorite": bool(row["favorite"]),
    }


def _fetch_transcription_record(transcription_id: int) -> dict | None:
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT id, created_at, text, source, duration_ms, model, is_local,
                       COALESCE(favorite, 0) AS favorite
                FROM transcriptions
                WHERE id = ?
                """,
                (int(transcription_id),),
            ).fetchone()
            return _row_to_transcription_dict(row)
    except Exception as e:
        log.warning("Failed to fetch transcription %s: %s", transcription_id, e)
        return None


def _fetch_transcription_history(
    limit: int = 1000,
    favorites_only: bool = False,
    newest_first: bool = False,
    history_window: str = "all",
) -> list[dict]:
    try:
        limit = max(1, min(int(limit), 5000))
    except Exception:
        limit = 1000
    order = "DESC" if newest_first else "ASC"
    where_clauses: list[str] = []
    params: list[object] = []
    if favorites_only:
        where_clauses.append("COALESCE(favorite, 0) = 1")
    cutoff = _HISTORY_WINDOWS.get(_normalize_history_window(history_window))
    if cutoff is not None:
        where_clauses.append("created_at >= ?")
        params.append((datetime.now(timezone.utc) - cutoff).isoformat())
    where = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"""
                SELECT id, created_at, text, source, duration_ms, model, is_local,
                       COALESCE(favorite, 0) AS favorite
                FROM transcriptions
                {where}
                ORDER BY id {order}
                LIMIT ?
                """,
                (*params, limit),
            ).fetchall()
            return [
                row_dict
                for row_dict in (_row_to_transcription_dict(row) for row in rows)
                if row_dict is not None
            ]
    except Exception as e:
        log.warning("Failed to fetch transcription history: %s", e)
        return []


# ── Remote transcription ──────────────────────────────────────────────────────


def _transcribe_remote(
    ip: str,
    port: int,
    wav_bytes: bytes,
    model_name: str = "",
    language: str | None = None,
    timeout: float = 60.0,
) -> str | None:
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
        self._favorites_window = None
        self._favorites_visible = False

    def set_window(self, window) -> None:
        self._window = window

    def set_favorites_window(self, window) -> None:
        self._favorites_window = window

    def _emit(self, event: str, data=None) -> None:
        if not self._window:
            return
        payload = json.dumps({"event": event, "data": data})
        self._window.evaluate_js(f"window.__onPythonEvent({json.dumps(payload)})")

    def _emit_favorites(self, event: str, data=None) -> None:
        if not self._favorites_window:
            return
        payload = json.dumps({"event": event, "data": data})
        self._favorites_window.evaluate_js(
            f"window.__onPythonEvent({json.dumps(payload)})"
        )

    def _notify_favorites_changed(self, record=None) -> None:
        try:
            self._emit_favorites("favorites_changed", record)
        except Exception as e:
            log.debug("Failed to notify favorites window: %s", e)
        try:
            self._emit("favorites_changed", record)
        except Exception as e:
            log.debug("Failed to notify main window: %s", e)

    def _notify_history_changed(self) -> None:
        if not self._window:
            return
        try:
            self._emit("history_settings_changed", None)
        except Exception as e:
            log.debug("Failed to notify history view: %s", e)

    def show_favorites_overlay(self) -> None:
        if not self._favorites_window:
            return
        try:
            self._favorites_window.show()
            self._favorites_visible = True
            self.refresh_favorites_overlay()
        except Exception as e:
            log.warning("Failed to show favorites overlay: %s", e)

    def hide_favorites_overlay(self) -> None:
        if not self._favorites_window:
            return
        try:
            self._favorites_window.hide()
            self._favorites_visible = False
            self._emit_favorites("favorites_window_closed", None)
        except Exception as e:
            log.warning("Failed to hide favorites overlay: %s", e)

    def toggle_favorites_overlay(self) -> None:
        if not self._favorites_window:
            return
        try:
            if self._favorites_visible:
                self.hide_favorites_overlay()
            else:
                self.show_favorites_overlay()
        except Exception as e:
            log.warning("Failed to toggle favorites overlay: %s", e)

    def refresh_favorites_overlay(self) -> None:
        if not self._favorites_window:
            return
        try:
            self._emit_favorites("favorites_refresh", None)
        except Exception as e:
            log.debug("Failed to refresh favorites overlay: %s", e)

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

    def _start_recording_stream(self) -> None:
        global _rec_active, _rec_paused, _rec_frames, _rec_stream
        import sounddevice as sd
        import numpy as np

        api_ref = self
        stream = None

        def _callback(indata, frames, time_info, status):
            if not _rec_paused:
                _rec_frames.append(indata.copy())
            rms = float(np.sqrt(np.mean(indata.astype(np.float64) ** 2)))
            level = round(min(1.0, rms / 4000.0), 3)
            api_ref._emit("audio_level", level)

        try:
            stream = sd.InputStream(
                samplerate=_SAMPLE_RATE,
                channels=1,
                dtype="int16",
                blocksize=_BLOCK_SIZE,
                callback=_callback,
            )
            stream.start()
        except Exception as e:
            try:
                if stream is not None:
                    stream.close()
            except Exception:
                pass
            _rec_active = False
            _rec_paused = False
            _rec_frames = []
            _rec_stream = None
            log.warning("Recording start failed: %s", e)
            self._emit(
                "error",
                "Unable to access the microphone. Check Microphone permission in System Settings.",
            )
            return

        _rec_active = True
        _rec_paused = False
        _rec_frames = []
        _rec_stream = stream
        self._emit("recording_started", None)
        log.info("Recording started")

    def _do_start(self) -> None:
        global _mic_permission_request_in_flight

        # AVFoundation permission checks only make sense when running as a frozen
        # app bundle. From the terminal, TCC belongs to the terminal emulator —
        # querying it here would check the Python interpreter's permission, which
        # is wrong and blocks recording even when the terminal has mic access.
        if getattr(sys, "frozen", False):
            status = _microphone_permission_status()
            if status in {"denied", "restricted"}:
                # Definitive denial — open the Privacy pane directly.
                log.warning(
                    "Recording start blocked: microphone permission is %s", status
                )
                subprocess.Popen(
                    [
                        "open",
                        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
                    ]
                )
                self._emit(
                    "error",
                    "Microphone access is denied. Opening System Settings — enable WhisperNote under Microphone, then try again.",
                )
                return

            if status == "undetermined":
                # macOS has not been asked yet — request via AVFoundation so
                # the system prompt appears and the app registers in Privacy settings.
                if not _mic_permission_request_in_flight:
                    _mic_permission_request_in_flight = True
                    log.info("Requesting microphone permission before recording")

                    def _after_request(granted: bool) -> None:
                        global _mic_permission_request_in_flight
                        _mic_permission_request_in_flight = False
                        if granted:
                            log.info("Microphone permission granted")
                            threading.Thread(
                                target=self._start_recording_stream,
                                daemon=True,
                            ).start()
                        else:
                            log.warning("Microphone permission denied")
                            self._emit(
                                "error",
                                "Enable Microphone access for WhisperNote in System Settings. If WhisperNote does not appear there, reset the Microphone permission and relaunch the app.",
                            )

                    if _request_microphone_permission_async(_after_request):
                        self._emit(
                            "error",
                            "WhisperNote is waiting for Microphone permission. Approve the macOS prompt, then click record again if needed.",
                        )
                        return
                    else:
                        # AVFoundation unavailable — fall through to sounddevice
                        # which will trigger the TCC prompt natively.
                        _mic_permission_request_in_flight = False
                        log.debug(
                            "AVFoundation unavailable; letting sounddevice trigger TCC prompt"
                        )
                else:
                    self._emit(
                        "error", "Microphone permission prompt is already pending."
                    )
                    return

            # "granted" or "unknown" (AVFoundation not bundled) — let sounddevice
            # open the stream; it will surface a real error if the mic is blocked.

        self._start_recording_stream()

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
                wf.setsampwidth(2)  # int16
                wf.setframerate(_SAMPLE_RATE)
                wf.writeframes(audio_np.tobytes())
            wav_bytes = buf.getvalue()
        except Exception as e:
            log.warning("Failed to build WAV from frames: %s", e)
            self._emit("transcription_error", "audio error")
            return

        text, source, duration_ms, model, is_local = self._transcribe_wav_bytes(
            wav_bytes
        )
        if text:
            record = self._save_transcription(
                text, source, duration_ms, model, is_local
            )
            self._emit(
                "transcription_result",
                record
                or {
                    "text": text,
                    "source": source or "unknown",
                    "duration_ms": duration_ms,
                    "model": model,
                    "is_local": is_local,
                    "favorite": False,
                },
            )
        else:
            self._emit("transcription_error", "nothing heard")

    def _transcribe_wav_bytes(
        self, wav_bytes: bytes
    ) -> tuple[str, str, int | None, str | None, bool]:
        """Route hosted/local ASR based on settings and return (text, source, duration_ms, model, is_local)."""
        import time

        start_time = time.monotonic()

        env = load_env()
        use_hosted_whisper, use_local_fallback = _derive_transcription_toggles(env)
        transcription_lang = env.get(_ENV_TRANSCRIPTION_LANGUAGE, "auto")

        if use_hosted_whisper:
            for key_ip, key_port, fallback_flag in [
                (_ENV_TRANSCRIBER_IP, _ENV_TRANSCRIBER_PORT, False),
                (_ENV_TRANSCRIBER_FALLBACK_IP, _ENV_TRANSCRIBER_FALLBACK_PORT, True),
            ]:
                ip = (env.get(key_ip) or "").strip()
                try:
                    port = int(env.get(key_port, "9000"))
                except (ValueError, TypeError):
                    port = 9000
                if ip:
                    remote_model = _get_remote_whisper_model(env, fallback_flag)
                    text = _transcribe_remote(
                        ip,
                        port,
                        wav_bytes,
                        model_name=remote_model,
                        language=transcription_lang
                        if transcription_lang != "auto"
                        else None,
                        timeout=60.0,
                    )
                    if text:
                        duration_ms = int((time.monotonic() - start_time) * 1000)
                        log.info("Remote ASR (%s): %s", ip, text[:100])
                        return (
                            text,
                            f"remote:{ip}:{port}:{remote_model}",
                            duration_ms,
                            remote_model,
                            False,
                        )

        if not use_local_fallback:
            return "", "", None, None, False

        # Local Whisper fallback (or primary if hosted is disabled)
        model_size = _get_local_whisper_model(env)
        model = _load_whisper(model_size)
        if model is None:
            return "", "", None, None, False
        tmp = Path(tempfile.mktemp(suffix=".wav"))
        try:
            tmp.write_bytes(wav_bytes)
            lang_arg = None if transcription_lang == "auto" else transcription_lang
            segments, _ = model.transcribe(str(tmp), language=lang_arg)
            text = " ".join(seg.text for seg in segments).strip()
            duration_ms = int((time.monotonic() - start_time) * 1000)
            log.info("Local Whisper: %s", text[:100])
            return text, f"local:{model_size}", duration_ms, model_size, True
        except Exception as e:
            log.warning("Local transcribe failed: %s", e)
            return "", "", None, None, False
            return "", ""
        finally:
            tmp.unlink(missing_ok=True)

    def _save_transcription(
        self,
        text: str,
        source: str,
        duration_ms: int | None = None,
        model: str | None = None,
        is_local: bool = False,
    ) -> dict | None:
        if not text.strip():
            return None
        created_at = datetime.now(timezone.utc).isoformat()
        try:
            with sqlite3.connect(DB_PATH) as conn:
                cur = conn.execute(
                    """
                    INSERT INTO transcriptions (
                        created_at, text, source, duration_ms, model, is_local, favorite
                    ) VALUES (?, ?, ?, ?, ?, ?, 0)
                    """,
                    (
                        created_at,
                        text.strip(),
                        source or "unknown",
                        duration_ms,
                        model,
                        1 if is_local else 0,
                    ),
                )
                conn.commit()
                transcription_id = cur.lastrowid
            return _fetch_transcription_record(transcription_id)
        except Exception as e:
            log.warning("Failed to save transcription: %s", e)
            return None

    def get_transcription_history(self, limit: int = 1000) -> list[dict]:
        env = load_env()
        return _fetch_transcription_history(
            limit,
            history_window=_get_history_window(env),
        )

    def get_favorite_transcriptions(self, limit: int = 1000) -> list[dict]:
        return _fetch_transcription_history(
            limit, favorites_only=True, newest_first=True
        )

    def toggle_transcription_favorite(
        self, transcription_id: int, favorite=None
    ) -> dict | None:
        try:
            transcription_id = int(transcription_id)
        except Exception:
            return None
        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.row_factory = sqlite3.Row
                row = conn.execute(
                    "SELECT COALESCE(favorite, 0) AS favorite FROM transcriptions WHERE id = ?",
                    (transcription_id,),
                ).fetchone()
                if row is None:
                    return None
                current = bool(row["favorite"])
                if favorite is None:
                    next_value = not current
                else:
                    next_value = bool(favorite)
                conn.execute(
                    "UPDATE transcriptions SET favorite = ? WHERE id = ?",
                    (1 if next_value else 0, transcription_id),
                )
                conn.commit()
            record = _fetch_transcription_record(transcription_id)
            self._notify_favorites_changed(record)
            return record
        except Exception as e:
            log.warning("Failed to toggle favorite for %s: %s", transcription_id, e)
            return None

    def favorite_latest_transcription(self) -> dict | None:
        try:
            with sqlite3.connect(DB_PATH) as conn:
                conn.row_factory = sqlite3.Row
                row = conn.execute(
                    """
                    SELECT id, COALESCE(favorite, 0) AS favorite
                    FROM transcriptions
                    ORDER BY id DESC
                    LIMIT 1
                    """
                ).fetchone()
                if row is None:
                    self._emit("error", "No saved notes yet.")
                    return None
                transcription_id = int(row["id"])
                if bool(row["favorite"]):
                    return _fetch_transcription_record(transcription_id)
                conn.execute(
                    "UPDATE transcriptions SET favorite = 1 WHERE id = ?",
                    (transcription_id,),
                )
                conn.commit()
            record = _fetch_transcription_record(transcription_id)
            self._notify_favorites_changed(record)
            return record
        except Exception as e:
            log.warning("Failed to favorite latest transcription: %s", e)
            return None

    def update_transcription_text(
        self, transcription_id: int, text: str
    ) -> dict | None:
        try:
            transcription_id = int(transcription_id)
        except Exception:
            return None
        cleaned = str(text).strip()
        try:
            with sqlite3.connect(DB_PATH) as conn:
                cur = conn.execute(
                    "UPDATE transcriptions SET text = ? WHERE id = ?",
                    (cleaned, transcription_id),
                )
                if cur.rowcount == 0:
                    return None
                conn.commit()
            record = _fetch_transcription_record(transcription_id)
            self._notify_favorites_changed(record)
            return record
        except Exception as e:
            log.warning(
                "Failed to update transcription text for %s: %s",
                transcription_id,
                e,
            )
            return None

    # ── File transcription ────────────────────────────────────────────────────────

    def get_supported_formats(self) -> list[str]:
        return list(SUPPORTED_AUDIO_EXTENSIONS)

    def transcribe_file(self, file_path: str) -> None:
        path = Path(file_path)
        if not path.exists():
            self._emit("transcription_error", "file not found")
            return
        ext = path.suffix.lower()
        if ext not in SUPPORTED_AUDIO_EXTENSIONS:
            self._emit("transcription_error", f"unsupported format: {ext}")
            return
        self._emit("transcribing_file", path.name)
        threading.Thread(
            target=self._do_transcribe_file,
            args=(path,),
            daemon=True,
        ).start()

    def transcribe_file_bytes(
        self, file_name: str, ext: str, audio_bytes: list
    ) -> None:
        if ext not in SUPPORTED_AUDIO_EXTENSIONS:
            self._emit("transcription_error", f"unsupported format: {ext}")
            return
        if not audio_bytes:
            self._emit("transcription_error", "empty file")
            return
        self._emit("transcribing_file", file_name)
        threading.Thread(
            target=self._do_transcribe_file_bytes,
            args=(file_name, ext, audio_bytes),
            daemon=True,
        ).start()

    def _do_transcribe_file_bytes(
        self, file_name: str, ext: str, audio_bytes: list
    ) -> None:
        import numpy as np

        try:
            bytes_data = bytes(audio_bytes)
            if ext == ".wav":
                wav_bytes = self._convert_wav_bytes_to_16khz(bytes_data)
            else:
                wav_bytes = self._convert_audio_bytes_to_wav(bytes_data)
            if not wav_bytes:
                self._emit("transcription_error", "could not process audio")
                return
            text, source, duration_ms, model, is_local = self._transcribe_wav_bytes(
                wav_bytes
            )
            if text:
                record = self._save_transcription(
                    text, source, duration_ms, model, is_local
                )
                self._emit(
                    "transcription_result",
                    record
                    or {
                        "text": text,
                        "source": source or "unknown",
                        "duration_ms": duration_ms,
                        "model": model,
                        "is_local": is_local,
                        "favorite": False,
                    },
                )
            else:
                self._emit("transcription_error", "no text recognized")
        except Exception as e:
            log.warning("File transcription failed: %s", e)
            self._emit("transcription_error", str(e))

    def _convert_audio_bytes_to_wav(self, audio_bytes: bytes) -> bytes | None:
        import numpy as np

        try:
            import soundfile as sf
            import scipy.signal as signal
        except ImportError:
            self._emit("error", "install soundfile to process audio files")
            return None
        try:
            with io.BytesIO(audio_bytes) as buf:
                audio_data, sr = sf.read(buf, dtype="float32")
            if audio_data.ndim > 1:
                audio_data = audio_data.mean(axis=1)
            target_sr = _SAMPLE_RATE
            if sr != target_sr:
                num_samples = int(len(audio_data) * target_sr / sr)
                audio_data = signal.resample(audio_data, num_samples)
            audio_int16 = (np.clip(audio_data, -1.0, 1.0) * 32767).astype(np.int16)
            return self._encode_wav(audio_int16)
        except Exception as e:
            log.warning("Audio conversion failed: %s", e)
            return None

    def _convert_wav_bytes_to_16khz(self, audio_bytes: bytes) -> bytes | None:
        import numpy as np

        try:
            import scipy.signal as signal
        except ImportError:
            return None
        try:
            with wave.open(io.BytesIO(audio_bytes), "rb") as src_wf:
                if src_wf.getnchannels() != 1 or src_wf.getsampwidth() != 2:
                    return None
                src_sr = src_wf.getframerate()
                frames = src_wf.readframes(src_wf.getnframes())
                audio_orig = np.frombuffer(frames, dtype=np.int16)
                if src_sr == _SAMPLE_RATE:
                    return self._encode_wav(audio_orig)
                num_samples = int(len(audio_orig) * _SAMPLE_RATE / src_sr)
                audio_resampled = signal.resample(
                    audio_orig.astype(np.float32), num_samples
                )
                audio_16khz = np.clip(audio_resampled, -32768, 32767).astype(np.int16)
                return self._encode_wav(audio_16khz)
        except Exception as e:
            log.warning("WAV conversion failed: %s", e)
            return None

    def _do_transcribe_file(self, path: Path) -> None:
        ext = path.suffix.lower()
        try:
            if ext == ".wav":
                wav_bytes = self._convert_wav_to_16khz(path)
            else:
                wav_bytes = self._convert_audio_to_wav(path)
            if not wav_bytes:
                self._emit("transcription_error", "could not process audio")
                return
            text, source, duration_ms, model, is_local = self._transcribe_wav_bytes(
                wav_bytes
            )
            if text:
                record = self._save_transcription(
                    text, source, duration_ms, model, is_local
                )
                self._emit(
                    "transcription_result",
                    record
                    or {
                        "text": text,
                        "source": source or "unknown",
                        "duration_ms": duration_ms,
                        "model": model,
                        "is_local": is_local,
                        "favorite": False,
                    },
                )
            else:
                self._emit("transcription_error", "no text recognized")
        except Exception as e:
            log.warning("File transcription failed: %s", e)
            self._emit("transcription_error", str(e))

    def _convert_audio_to_wav(self, path: Path) -> bytes | None:
        import numpy as np

        try:
            import soundfile as sf
        except ImportError:
            self._emit("error", "install soundfile to process audio files")
            return None
        try:
            audio_data, sr = sf.read(str(path), dtype="float32")
            if audio_data.ndim > 1:
                audio_data = audio_data.mean(axis=1)
            target_sr = _SAMPLE_RATE
            if sr != target_sr:
                import scipy.signal as signal

                num_samples = int(len(audio_data) * target_sr / sr)
                audio_data = signal.resample(audio_data, num_samples)
            audio_int16 = (np.clip(audio_data, -1.0, 1.0) * 32767).astype(np.int16)
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(target_sr)
                wf.writeframes(audio_int16.tobytes())
            return buf.getvalue()
        except Exception as e:
            log.warning("Audio conversion failed: %s", e)
            return None

    def _convert_wav_to_16khz(self, path: Path) -> bytes | None:
        import numpy as np

        try:
            with wave.open(str(path), "rb") as src_wf:
                if src_wf.getnchannels() != 1:
                    return None
                if src_wf.getsampwidth() != 2:
                    return None
                src_sr = src_wf.getframerate()
                frames = src_wf.readframes(src_wf.getnframes())
                audio_orig = np.frombuffer(frames, dtype=np.int16)
                if src_sr == _SAMPLE_RATE:
                    return self._encode_wav(audio_orig)
                import scipy.signal as signal

                num_samples = int(len(audio_orig) * _SAMPLE_RATE / src_sr)
                audio_resampled = signal.resample(
                    audio_orig.astype(np.float32), num_samples
                )
                audio_16khz = np.clip(audio_resampled, -32768, 32767).astype(np.int16)
                return self._encode_wav(audio_16khz)
        except Exception as e:
            log.warning("WAV conversion failed: %s", e)
            return None

    def _encode_wav(self, audio_np) -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(_SAMPLE_RATE)
            wf.writeframes(audio_np.tobytes())
        return buf.getvalue()

    # ── Settings ──────────────────────────────────────────────────────────────

    def get_settings(self) -> dict:
        env = load_env()
        use_hosted_whisper, use_local_fallback = _derive_transcription_toggles(env)
        return {
            "local_whisper_model": _get_local_whisper_model(env),
            "transcriber_ip": env.get(_ENV_TRANSCRIBER_IP, ""),
            "transcriber_port": env.get(_ENV_TRANSCRIBER_PORT, "9000"),
            "transcriber_model": _get_remote_whisper_model(env, False),
            "transcriber_fallback_ip": env.get(_ENV_TRANSCRIBER_FALLBACK_IP, ""),
            "transcriber_fallback_port": env.get(
                _ENV_TRANSCRIBER_FALLBACK_PORT, "9000"
            ),
            "transcriber_fallback_model": _get_remote_whisper_model(env, True),
            "always_on_top": env.get(_ENV_ALWAYS_ON_TOP, "true").lower() != "false",
            "use_hosted_whisper": use_hosted_whisper,
            "use_local_fallback": use_local_fallback,
            "transcription_language": env.get(_ENV_TRANSCRIPTION_LANGUAGE, "auto"),
            "history_window": _get_history_window(env),
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
            env[_ENV_TRANSCRIBER_MODEL] = (
                str(data["transcriber_model"]).strip() or "medium"
            )
        if "transcriber_fallback_ip" in data:
            env[_ENV_TRANSCRIBER_FALLBACK_IP] = (
                str(data["transcriber_fallback_ip"]).strip() or ""
            )
        if "transcriber_fallback_port" in data:
            env[_ENV_TRANSCRIBER_FALLBACK_PORT] = (
                str(data["transcriber_fallback_port"]).strip() or "9000"
            )
        if "transcriber_fallback_model" in data:
            env[_ENV_TRANSCRIBER_FALLBACK_MODEL] = (
                str(data["transcriber_fallback_model"]).strip() or "medium"
            )
        if "always_on_top" in data:
            env[_ENV_ALWAYS_ON_TOP] = "true" if data["always_on_top"] else "false"
            self._apply_on_top(bool(data["always_on_top"]))
        if "use_hosted_whisper" in data:
            env[_ENV_USE_HOSTED_WHISPER] = (
                "true" if data["use_hosted_whisper"] else "false"
            )
        if "use_local_fallback" in data:
            env[_ENV_USE_LOCAL_FALLBACK] = (
                "true" if data["use_local_fallback"] else "false"
            )
        if "transcription_language" in data:
            lang = str(data["transcription_language"]).strip()
            if lang in ("auto", "en", "de"):
                env[_ENV_TRANSCRIPTION_LANGUAGE] = lang
            else:
                env[_ENV_TRANSCRIPTION_LANGUAGE] = "auto"
        if "history_window" in data:
            env[_ENV_HISTORY_WINDOW] = _normalize_history_window(data["history_window"])

        use_hosted_whisper, use_local_fallback = _derive_transcription_toggles(env)
        if not use_hosted_whisper and not use_local_fallback:
            raise ValueError("Enable hosted or local transcription.")
        save_env(env)
        self._notify_history_changed()

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

        def _destroy_window_async(target_window) -> None:
            if not target_window:
                return

            try:
                target_window.destroy()
            except Exception:
                pass

        try:
            if self._favorites_window:
                try:
                    self._favorites_window.hide()
                except Exception:
                    pass
            if self._window:
                _destroy_window_async(self._window)
            if self._favorites_window:
                _destroy_window_async(self._favorites_window)
            try:
                from PyObjCTools import AppHelper

                AppHelper.stopEventLoop()
            except Exception as e:
                log.debug("Failed to stop Cocoa event loop: %s", e)
        except Exception:
            try:
                if self._window:
                    self._window.destroy()
            except Exception:
                pass
            try:
                if self._favorites_window:
                    self._favorites_window.destroy()
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
    """Register ⌃⌘A and ⌃⌘Y as global hotkeys.

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
        _Y = 16  # kVK_ANSI_Y

        def _on_key(event):
            try:
                flags = int(event.modifierFlags())
                key_code = int(event.keyCode())
                chars = ""
                try:
                    chars = (event.charactersIgnoringModifiers() or "").lower()
                except Exception:
                    chars = ""
                if (
                    (flags & _CMD)
                    and (flags & _CTRL)
                    and not (flags & _OPT)
                    and not (flags & _SHFT)
                ):
                    if key_code == _A or chars == "a":
                        # Call Python recording directly — no JS or evaluate_js needed.
                        # Spawn a thread so we don't block the Cocoa event queue.
                        log.debug("Global hotkey detected: ⌃⌘A")
                        threading.Thread(
                            target=api.toggle_recording, daemon=True
                        ).start()
                    elif key_code == _Y or chars == "y":
                        log.debug("Global hotkey detected: ⌃⌘Y")
                        threading.Thread(
                            target=api.favorite_latest_transcription, daemon=True
                        ).start()
            except Exception:
                pass

        def _register():
            global _hotkey_monitor
            _hotkey_monitor = NSEvent.addGlobalMonitorForEventsMatchingMask_handler_(
                int(NSEventMaskKeyDown),
                _on_key,
            )
            log.info("Global hotkeys ready: ⌃⌘A, ⌃⌘Y")

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
        log.warning(
            "Global hotkey setup failed (window-focus shortcut still works): %s", e
        )


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


# ── Headphone media key listener ───────────────────────────────────────────────
# Note: Bluetooth headphones (Jabra, AirPods, etc.) use AVRCP media control protocol,
# not HID keyboard events. pynput captures keyboard but not headphone buttons.
# Full support would require CGEvent tap with Accessibility permission.
_media_key_listener = None


def _setup_media_keys(api: WhisperNoteAPI) -> None:
    """Register headphone media keys (play/pause) to toggle recording."""
    global _media_key_listener
    try:
        from pynput import keyboard
    except ImportError as e:
        log.warning("pynput not available: %s", e)
        return

    NX_KEYTYPE_PLAY = 16  # Play/pause media key

    def _on_press(key):
        try:
            key_code = key.vk if hasattr(key, "vk") else None
            key_char = getattr(key, "char", None)
            log.warning("DEBUG pynput: key.vk=%s key.char=%s", key_code, key_char)
            if key_code in (0x19,):
                threading.Thread(target=api.toggle_recording, daemon=True).start()
        except Exception as e:
            log.warning("DEBUG: Exception in pynput: %s", e)

    def _on_release(key):
        pass

    try:
        _media_key_listener = keyboard.Listener(
            on_press=_on_press, on_release=_on_release
        )
        _media_key_listener.start()
        log.info("Headphone media keys (pynput) ready")
    except Exception as e:
        log.warning("Headphone media key setup failed: %s", e)


def _teardown_media_keys() -> None:
    global _media_key_listener
    if _media_key_listener is None:
        return
    try:
        _media_key_listener.stop()
    except Exception as e:
        log.debug("Headphone media key teardown failed: %s", e)
    finally:
        _media_key_listener = None


def _graceful_shutdown_or_force_exit(timeout_s: float = 1.5) -> None:
    """Best-effort shutdown cleanup after the GUI loop has already exited."""
    _teardown_global_hotkey()
    _teardown_media_keys()
    _shutdown_whisper_cache()

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        alive = [
            t
            for t in threading.enumerate()
            if t is not threading.main_thread() and t.is_alive() and not t.daemon
        ]
        if not alive:
            return
        time.sleep(0.05)

    lingering = [
        t.name
        for t in threading.enumerate()
        if t is not threading.main_thread() and t.is_alive() and not t.daemon
    ]
    if lingering:
        log.warning(
            "Lingering non-daemon threads after GUI shutdown: %s",
            ", ".join(lingering),
        )


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
    w = geom.get("width", 340)
    h = geom.get("height", 560)
    x = geom.get("x")
    y = geom.get("y")
    if x is not None and y is not None:
        if x < -100 or y < -100 or x > 16000 or y > 16000:
            x = None
            y = None
    else:
        x = None
        y = None

    ui_dir = _resource_root() / "ui"
    favorites_url = (ui_dir / "favorites.html").as_uri()

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

    favorites_window = webview.create_window(
        "whisper note • favorites",
        url=favorites_url,
        js_api=api,
        width=max(w, 980),
        height=max(h, 700),
        x=None,
        y=None,
        frameless=True,
        fullscreen=False,
        on_top=on_top,
        transparent=False,
        resizable=True,
        hidden=True,
        easy_drag=False,
        shadow=True,
        focus=True,
        min_size=(760, 520),
        background_color="#0a0d14",
    )
    api.set_favorites_window(favorites_window)

    if sys.platform == "darwin":
        threading.Thread(target=_preflight_microphone_permission, daemon=True).start()

    window.events.loaded += lambda: _setup_global_hotkey(window, api)
    favorites_window.events.loaded += lambda: api.refresh_favorites_overlay()

    if sys.platform == "darwin":
        threading.Thread(target=_setup_media_keys, args=(api,), daemon=True).start()
    else:
        log.debug("Media key listener only available on macOS")

    try:
        webview.start(debug=False)
    except Exception:
        log.exception("webview.start() raised an exception")
        raise
    log.info("=== whisper-note exited cleanly ===")
    _graceful_shutdown_or_force_exit()
    sys.exit(0)


if __name__ == "__main__":
    if getattr(sys, "frozen", False):
        multiprocessing.freeze_support()
    main()
