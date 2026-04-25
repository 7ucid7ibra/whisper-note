/* ── State ────────────────────────────────────────────────────────────────── */
let isRecording     = false;
let recordingPaused = false;
let animationId     = null;
let waveformCanvas  = null;
let pauseHoverDiscard = false;

// Rolling level buffer — filled by Python audio_level events, drives waveform
const _LVL_LEN  = 18;
const _levelBuf = new Float32Array(_LVL_LEN);
let   _levelHead = 0;

let _transcribingEl    = null;
let _transcribingCount = 0;
let _historyEmptyEl    = null;
let _historyItemsById  = new Map();

let _favoritesOverlayOpen = false;
let _favoritesOverlayFocusedWrap = null;
let _favoritesOverlayFocusedId = null;
let _favoritesOverlayItemsById = new Map();
let _favoritesOverlayLoadToken = 0;
let _favoritesOverlayCloseTimer = null;
let _favoritesLoadRetryTimer = null;
let _favoritesPageLoadToken = 0;

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const messages                   = document.getElementById("messages");
const shell                      = document.getElementById("shell");
const topControls                = document.querySelector(".top-controls");
const chatWrap                   = document.getElementById("chatWrap");
const bottomBar                  = document.querySelector(".bottom-bar");
const micBtn                     = document.getElementById("micBtn");
const micWrap                    = document.getElementById("micWrap");
const closeBtn                   = document.getElementById("closeBtn");
const infoBtn                    = document.getElementById("infoBtn");
const helpCard                   = document.getElementById("helpCard");
const settingsBtn                = document.getElementById("settingsBtn");
const nodesBtn                   = document.getElementById("nodesBtn");
const settingsOverlay            = document.getElementById("settingsOverlay");
const settingsPanel              = settingsOverlay ? settingsOverlay.querySelector(".settings-panel") : null;
const settingsClose              = document.getElementById("settingsClose");
const settingsSave               = document.getElementById("settingsSave");
const localWhisperModelSel       = document.getElementById("localWhisperModelSelect");
const transcriberIpInput         = document.getElementById("transcriberIpInput");
const transcriberPortInput       = document.getElementById("transcriberPortInput");
const transcriberModelSel        = document.getElementById("transcriberModelSelect");
const transcriberFallbackIpInput = document.getElementById("transcriberFallbackIpInput");
const transcriberFallbackPortInput = document.getElementById("transcriberFallbackPortInput");
const transcriberFallbackModelSel = document.getElementById("transcriberFallbackModelSelect");
const alwaysOnTopToggle          = document.getElementById("alwaysOnTopToggle");
const useHostedWhisperToggle     = document.getElementById("useHostedWhisperToggle");
const useLocalFallbackToggle     = document.getElementById("useLocalFallbackToggle");
const languageSelect             = document.getElementById("languageSelect");
const historyWindowSelect        = document.getElementById("historyWindowSelect");
const nodesOverlay               = document.getElementById("nodesOverlay");
const nodesBackdrop              = document.getElementById("nodesBackdrop");
const nodesModal                 = document.getElementById("nodesModal");
const nodesClose                 = document.getElementById("nodesClose");
const nodesGrid                  = document.getElementById("nodesGrid");
const nodesFocusStage            = document.getElementById("nodesFocusStage");
const nodesCount                 = document.getElementById("nodesCount");

const APP_VIEW = new URLSearchParams(window.location.search).get("view") || "main";
const IS_FAVORITES_VIEW = document.body.classList.contains("favorites-view") || APP_VIEW === "favorites";
if (IS_FAVORITES_VIEW) {
  document.body.classList.add("favorites-view");
}

let _borderGlowFrame = 0;
let _borderGlowX = 0;
let _borderGlowY = 0;
let _borderGlowVisible = false;
let _borderGlowLastEdge = -1;
let _borderGlowLastX = "";
let _borderGlowLastY = "";

if (shell) {
  shell.classList.add("edge-glow-target");
}

function _setBorderGlowState(edge, xPct, yPct) {
  if (!shell) return;
  const nextEdge = Math.max(0, Math.min(1, edge));
  const nextX = `${xPct.toFixed(2)}%`;
  const nextY = `${yPct.toFixed(2)}%`;

  if (
    _borderGlowVisible &&
    Math.abs(nextEdge - _borderGlowLastEdge) < 0.01 &&
    nextX === _borderGlowLastX &&
    nextY === _borderGlowLastY
  ) {
    return;
  }

  _borderGlowVisible = nextEdge > 0;
  _borderGlowLastEdge = nextEdge;
  _borderGlowLastX = nextX;
  _borderGlowLastY = nextY;
  shell.style.setProperty("--glow-edge", nextEdge.toFixed(3));
  shell.style.setProperty("--glow-x", nextX);
  shell.style.setProperty("--glow-y", nextY);
}

function _clearBorderGlowState() {
  if (!shell || !_borderGlowVisible) return;
  _borderGlowVisible = false;
  _borderGlowLastEdge = -1;
  _borderGlowLastX = "";
  _borderGlowLastY = "";
  shell.style.setProperty("--glow-edge", "0");
}

function _scheduleBorderGlowUpdate(clientX, clientY) {
  _borderGlowX = clientX;
  _borderGlowY = clientY;
  if (_borderGlowFrame) return;
  _borderGlowFrame = requestAnimationFrame(() => {
    _borderGlowFrame = 0;
    const w = window.innerWidth || document.documentElement.clientWidth || 1;
    const h = window.innerHeight || document.documentElement.clientHeight || 1;
    const x = Math.min(Math.max(_borderGlowX, 0), w);
    const y = Math.min(Math.max(_borderGlowY, 0), h);
    const sensitivity = 34;
    const edgeDist = Math.min(x, y, w - x, h - y);
    const edge = Math.max(0, Math.min(1, 1 - (edgeDist / sensitivity)));
    if (edge <= 0) {
      _clearBorderGlowState();
      return;
    }
    _setBorderGlowState(edge, (x / w) * 100, (y / h) * 100);
  });
}

document.addEventListener("pointermove", (e) => {
  _scheduleBorderGlowUpdate(e.clientX, e.clientY);
}, { passive: true });
document.addEventListener("pointerleave", () => {
  if (_borderGlowFrame) {
    cancelAnimationFrame(_borderGlowFrame);
    _borderGlowFrame = 0;
  }
  _clearBorderGlowState();
});

/* ── Sounds (Web Audio API — no external files needed) ────────────────────── */
function _beep(freq, duration, vol = 0.07, delay = 0) {
  try {
    const ac  = new AudioContext();
    const osc = ac.createOscillator();
    const g   = ac.createGain();
    osc.connect(g);
    g.connect(ac.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, ac.currentTime + delay);
    g.gain.setValueAtTime(0.001, ac.currentTime + delay);
    g.gain.linearRampToValueAtTime(vol, ac.currentTime + delay + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + delay + duration);
    osc.start(ac.currentTime + delay);
    osc.stop(ac.currentTime + delay + duration + 0.02);
    osc.onended = () => ac.close();
  } catch (_) {}
}
// Recording starts  — quick rising two-note blip
function playStartSound() { _beep(660, 0.09, 0.07); _beep(880, 0.11, 0.06, 0.08); }
// Recording stops   — soft falling pair
function playStopSound()  { _beep(660, 0.08, 0.07); _beep(440, 0.10, 0.05, 0.07); }
// Transcription done — gentle three-note chime (C5 → E5 → G5)
function playDoneSound()  {
  _beep(523, 0.14, 0.07);
  _beep(659, 0.18, 0.06, 0.13);
  _beep(784, 0.22, 0.05, 0.24);
}

/* ── Python event bus ─────────────────────────────────────────────────────── */
window.__onPythonEvent = (raw) => {
  const { event, data } = JSON.parse(raw);
  switch (event) {

    case "recording_started":
      isRecording = true;
      recordingPaused = false;
      micBtn.classList.add("recording");
      _levelBuf.fill(0); _levelHead = 0;
      startWaveformCanvas();
      drawWaveformFromLevels();
      playStartSound();
      break;

    case "audio_level":
      _levelBuf[_levelHead % _LVL_LEN] = data || 0;
      _levelHead++;
      break;

    case "recording_paused":
      recordingPaused = true;
      micBtn.classList.add("paused");
      if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
      drawPausedWaveform(false);
      break;

    case "recording_resumed":
      recordingPaused = false;
      micBtn.classList.remove("paused");
      drawWaveformFromLevels();
      break;

    case "recording_stopped":
      isRecording = false;
      recordingPaused = false;
      micBtn.classList.remove("recording", "paused");
      stopWaveform();
      playStopSound();
      break;

    case "recording_discarded":
      isRecording = false;
      recordingPaused = false;
      micBtn.classList.remove("recording", "paused");
      stopWaveform();
      break;

    case "transcription_start":
    case "transcribing_file":
      _showTranscribingIndicator();
      break;

    case "transcription_result":
      _removeTranscribingIndicator();
      playDoneSound();
      const transcription = typeof data === "string" ? { text: data } : (data || {});
      if (transcription.text && transcription.text.trim()) {
        navigator.clipboard.writeText(transcription.text.trim()).catch(() => {});
        appendVoiceBubble(transcription);
      }
      break;

    case "transcription_error":
      _removeTranscribingIndicator();
      showSystem(data || "transcription failed");
      break;

    case "favorites_refresh":
    case "favorites_window_opened":
      if (IS_FAVORITES_VIEW) {
        _loadFavoritesPage();
      }
      break;

    case "favorites_window_closed":
      if (IS_FAVORITES_VIEW) {
        _favoritesOverlayOpen = false;
        nodesOverlay.classList.remove("open");
        nodesOverlay.hidden = true;
      }
      break;

    case "favorites_changed":
      if (IS_FAVORITES_VIEW) {
        _loadFavoritesPage();
      } else {
        _applyTranscriptionUpdate(data);
      }
      break;

    case "history_settings_changed":
      if (!IS_FAVORITES_VIEW) {
        _refreshHistoryLoad();
      }
      break;

    case "error":
      showSystem(data);
      break;
  }
};

/* ── Transcribing indicator ───────────────────────────────────────────────── */
// Uses a counter so concurrent transcriptions each get tracked properly.
function _showTranscribingIndicator() {
  _transcribingCount++;
  if (_transcribingEl) {
    // Already visible — update label to show how many are queued
    const lbl = _transcribingEl.querySelector(".transcribing-label");
    if (lbl) lbl.textContent = _transcribingCount > 1
      ? `transcribing (${_transcribingCount})\u2026`
      : "transcribing\u2026";
    return;
  }
  _transcribingEl = document.createElement("div");
  _transcribingEl.className = "msg transcribing";
  _transcribingEl.innerHTML =
    '<span class="transcribe-dots"><span></span><span></span><span></span></span>'
    + ' <span class="transcribing-label">transcribing\u2026</span>';
  messages.appendChild(_transcribingEl);
  scrollBottom();
}
function _removeTranscribingIndicator() {
  _transcribingCount = Math.max(0, _transcribingCount - 1);
  if (_transcribingCount === 0) {
    if (_transcribingEl) { _transcribingEl.remove(); _transcribingEl = null; }
  } else if (_transcribingEl) {
    const lbl = _transcribingEl.querySelector(".transcribing-label");
    if (lbl) lbl.textContent = `transcribing (${_transcribingCount})\u2026`;
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function escapeHtml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function showSystem(msg) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = msg;
  messages.appendChild(div);
  scrollBottom();
}
function scrollBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function _apiReady() {
  return typeof pywebview !== "undefined" && pywebview.api;
}

function _whenApiReady(callback) {
  if (_apiReady()) {
    callback();
    return;
  }
  window.addEventListener("pywebviewready", () => {
    if (_apiReady()) callback();
  }, { once: true });
}

function _clearHistoryEmpty() {
  if (_historyEmptyEl) {
    _historyEmptyEl.remove();
    _historyEmptyEl = null;
  }
}

function _renderHistoryEmpty(message) {
  if (!messages) return;
  _clearHistoryEmpty();
  const empty = document.createElement("div");
  empty.className = "history-empty";
  empty.textContent = message;
  messages.appendChild(empty);
  _historyEmptyEl = empty;
}

function _refreshHistoryLoad({ preserveScroll = false } = {}) {
  if (IS_FAVORITES_VIEW) return;
  const scrollTop = preserveScroll ? messages.scrollTop : 0;
  _historyLoaded = false;
  _historyItemsById.clear();
  messages.innerHTML = "";
  _clearHistoryEmpty();
  _scheduleHistoryLoad({ preserveScroll, scrollTop });
}

function _applyTranscriptionUpdate(record) {
  const normalized = _normalizeTranscriptionRecord(record);
  if (!normalized || normalized.id == null) return;

  const id = String(normalized.id);

  const historyItem = _historyItemsById.get(id);
  if (historyItem) {
    historyItem.record = normalized;
    _renderVoiceBubbleBody(
      historyItem.bubble,
      normalized.text,
      historyItem.favoriteBtn,
      normalized.favorite,
      normalized.id,
    );
  }

  const favoritesItem = _favoritesOverlayItemsById.get(id);
  if (favoritesItem) {
    if (!normalized.favorite) {
      _removeFavoritesPageItem(id);
    } else {
      favoritesItem.record = normalized;
      _renderVoiceBubbleBody(
        favoritesItem.bubble,
        normalized.text,
        favoritesItem.favoriteBtn,
        normalized.favorite,
        normalized.id,
      );
    }
  }
}

function _removeFavoritesPageItem(transcriptionId) {
  const id = String(transcriptionId);
  const item = _favoritesOverlayItemsById.get(id);
  if (!item) return;
  item.wrap.remove();
  _favoritesOverlayItemsById.delete(id);
  _syncFavoritesOverlayCount();
  if (_favoritesOverlayItemsById.size === 0) {
    _renderFavoritesPageEmpty();
  }
}

function _renderFavoritesPageEmpty(message = "No favorites yet. Turn on the LED on a note to pin it here.") {
  if (!messages) return;
  _favoritesOverlayItemsById.clear();
  messages.innerHTML = "";
  _clearHistoryEmpty();
  const empty = document.createElement("div");
  empty.className = "history-empty";
  empty.textContent = message;
  messages.appendChild(empty);
  _historyEmptyEl = empty;
  _syncFavoritesOverlayCount(0);
}

function _renderFavoritesPageRows(rows) {
  if (!messages) return;
  _favoritesOverlayItemsById.clear();
  messages.innerHTML = "";
  _clearHistoryEmpty();

  const normalizedRows = Array.isArray(rows)
    ? rows.map((row) => _normalizeTranscriptionRecord(row)).filter(Boolean)
    : [];

  if (normalizedRows.length === 0) {
    _renderFavoritesPageEmpty();
    return;
  }

  const frag = document.createDocumentFragment();
  normalizedRows.forEach((row, index) => {
    const item = _createVoiceBubble(row, {
      mode: "overlay",
      onFocus: (payload) => {
        if (!payload || !payload.bubble || !payload.wrap) return;
        startEditBubble(payload.bubble, payload.wrap, {
          onEscape: () => {
            _closeFavoritesWindow();
          },
        });
      },
      onFavoriteChanged: ({ favorite, updated, record }) => {
        const id = String((record && record.id) || row.id);
        if (!favorite) {
          _removeFavoritesPageItem(id);
          return;
        }
        const existing = _favoritesOverlayItemsById.get(id);
        if (!existing) return;
        const nextRecord = _normalizeTranscriptionRecord(updated || record || row);
        if (!nextRecord) return;
        existing.record = nextRecord;
        _renderVoiceBubbleBody(
          existing.bubble,
          nextRecord.text,
          existing.favoriteBtn,
          nextRecord.favorite,
          nextRecord.id,
        );
      },
    });
    if (!item) return;
    item.wrap.classList.add("favorites-grid-item");
    item.wrap.style.setProperty("--enter-delay", `${index * 34}ms`);
    item.record = row;
    _favoritesOverlayItemsById.set(String(row.id), item);
    frag.appendChild(item.wrap);
  });

  messages.appendChild(frag);
  _syncFavoritesOverlayCount(normalizedRows.length);
}

async function _loadFavoritesPage() {
  const token = ++_favoritesPageLoadToken;
  if (!_apiReady() || !pywebview.api.get_favorite_transcriptions) {
    _renderFavoritesPageEmpty("Loading favorite notes…");
    if (_favoritesLoadRetryTimer) clearTimeout(_favoritesLoadRetryTimer);
    _favoritesLoadRetryTimer = setTimeout(() => {
      if (IS_FAVORITES_VIEW) _loadFavoritesPage();
    }, 60);
    return;
  }

  if (_favoritesLoadRetryTimer) {
    clearTimeout(_favoritesLoadRetryTimer);
    _favoritesLoadRetryTimer = null;
  }

  try {
    const rows = await pywebview.api.get_favorite_transcriptions();
    if (token !== _favoritesPageLoadToken || !IS_FAVORITES_VIEW) return;
    _renderFavoritesPageRows(rows);
  } catch (e) {
    if (token !== _favoritesPageLoadToken || !IS_FAVORITES_VIEW) return;
    _renderFavoritesPageEmpty((e && e.message) || "Could not load favorite notes.");
  }
}

/* ── Waveform ─────────────────────────────────────────────────────────────── */
function startWaveformCanvas() {
  if (waveformCanvas) { waveformCanvas.remove(); waveformCanvas = null; }
  if (animationId)    { cancelAnimationFrame(animationId); animationId = null; }

  // Slide button to left first, then canvas slides in from right (CSS handles both)
  micWrap.classList.add("is-recording");

  waveformCanvas = document.createElement("canvas");
  waveformCanvas.className = "waveform-canvas";
  // Canvas pixel size = micWrap width minus button (44) minus gap (8)
  const w = Math.max(micWrap.offsetWidth - 52, 80);
  waveformCanvas.width  = w;
  waveformCanvas.height = 38;
  micWrap.appendChild(waveformCanvas);
  pauseHoverDiscard = false;
  _bindWaveformPauseInteractions();
}

function _roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

// Waveform is driven by Python audio_level events stored in _levelBuf.
// The 36 bars mirror the last 18 samples from newest (centre) to oldest (edges).
function drawWaveformFromLevels() {
  if (!waveformCanvas) return;
  const ctx    = waveformCanvas.getContext("2d");
  const width  = waveformCanvas.width;
  const height = waveformCanvas.height;
  ctx.clearRect(0, 0, width, height);

  const NUM_BARS = 36;
  const HALF     = NUM_BARS / 2;
  const slotW    = width / NUM_BARS;
  const barW     = slotW * 0.55;
  const offsetX  = (slotW - barW) / 2;
  const radius   = barW / 2;
  const minH     = 3;

  for (let i = 0; i < NUM_BARS; i++) {
    const offset = i < HALF ? (HALF - 1 - i) : (i - HALF);
    const idx    = ((_levelHead - 1 - offset) % _LVL_LEN + _LVL_LEN) % _LVL_LEN;
    const level  = _levelBuf[idx] || 0;
    const barH   = Math.max(minH, Math.pow(level, 0.45) * (height - 6) * 0.92);
    const x      = i * slotW + offsetX;
    const y      = (height - barH) / 2;

    ctx.shadowBlur  = 10;
    ctx.shadowColor = "rgba(167, 139, 250, 0.22)";

    const grad = ctx.createLinearGradient(x, y, x, y + barH);
    grad.addColorStop(0,    "rgba(230, 220, 255, 0.38)");
    grad.addColorStop(0.18, "rgba(167, 139, 250, 0.42)");
    grad.addColorStop(0.65, "rgba(130, 100, 220, 0.25)");
    grad.addColorStop(1,    "rgba(100,  70, 200, 0.08)");
    ctx.fillStyle = grad;
    _roundRect(ctx, x, y, barW, barH, radius);
    ctx.fill();

    ctx.shadowBlur = 0;
    const shineH = barH * 0.28;
    const shine  = ctx.createLinearGradient(x, y, x, y + shineH);
    shine.addColorStop(0, "rgba(255, 255, 255, 0.18)");
    shine.addColorStop(1, "rgba(255, 255, 255, 0.00)");
    ctx.fillStyle = shine;
    _roundRect(ctx, x + 1, y + 1, barW - 2, shineH, radius);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  animationId = requestAnimationFrame(drawWaveformFromLevels);
}

function stopWaveform() {
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }

  // Slide button back to centre
  micWrap.classList.remove("is-recording");

  if (waveformCanvas) {
    const canvas = waveformCanvas;
    waveformCanvas = null;
    if (canvas.classList.contains("discarding")) {
      // Discard animation already playing — let it finish then remove
      canvas.addEventListener("animationend", () => canvas.remove(), { once: true });
    } else {
      // Fade out while button slides back
      canvas.style.transition = "opacity 0.25s ease";
      canvas.style.opacity    = "0";
      setTimeout(() => canvas.remove(), 260);
    }
  }
  pauseHoverDiscard = false;
  micBtn.classList.remove("paused");
}

function drawPausedWaveform(showDiscard = false) {
  if (!waveformCanvas) return;
  const ctx    = waveformCanvas.getContext("2d");
  const width  = waveformCanvas.width;
  const height = waveformCanvas.height;
  ctx.fillStyle = "rgba(8, 8, 18, 0.50)";
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  if (showDiscard) {
    ctx.strokeStyle = "rgba(255, 85, 85, 0.92)";
    ctx.lineWidth   = 2.2;
    ctx.lineCap     = "round";
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy - 6); ctx.lineTo(cx + 6, cy + 6);
    ctx.moveTo(cx + 6, cy - 6); ctx.lineTo(cx - 6, cy + 6);
    ctx.stroke();
    return;
  }
  const bw = 3, bh = 13;
  ctx.fillStyle = "rgba(255, 200, 80, 0.60)";
  ctx.beginPath(); ctx.roundRect(cx - 6 - bw, cy - bh / 2, bw, bh, 1.5); ctx.fill();
  ctx.beginPath(); ctx.roundRect(cx + 6,       cy - bh / 2, bw, bh, 1.5); ctx.fill();
}

function _pauseIconHotspot(event) {
  if (!waveformCanvas) return false;
  const rect = waveformCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const x  = ((event.clientX - rect.left)  / rect.width)  * waveformCanvas.width;
  const y  = ((event.clientY - rect.top)   / rect.height) * waveformCanvas.height;
  const cx = waveformCanvas.width  / 2;
  const cy = waveformCanvas.height / 2;
  return Math.abs(x - cx) <= 14 && Math.abs(y - cy) <= 14;
}

function _discardActiveRecording() {
  if (!isRecording) return;
  if (waveformCanvas) waveformCanvas.classList.add("discarding");
  setTimeout(() => {
    pywebview.api.discard_recording();
  }, 140);
}

function _bindWaveformPauseInteractions() {
  if (!waveformCanvas) return;
  waveformCanvas.addEventListener("mousemove", (e) => {
    if (!recordingPaused) { waveformCanvas.style.cursor = "default"; return; }
    const hot = _pauseIconHotspot(e);
    if (hot !== pauseHoverDiscard) {
      pauseHoverDiscard = hot;
      drawPausedWaveform(pauseHoverDiscard);
    }
    waveformCanvas.style.cursor = hot ? "pointer" : "default";
  });
  waveformCanvas.addEventListener("mouseleave", () => {
    if (!recordingPaused) return;
    pauseHoverDiscard = false;
    drawPausedWaveform(false);
    waveformCanvas.style.cursor = "default";
  });
  waveformCanvas.addEventListener("click", (e) => {
    if (recordingPaused && _pauseIconHotspot(e)) _discardActiveRecording();
  });
}

/* ── Mic button ───────────────────────────────────────────────────────────── */
// Recording is handled entirely in Python (sounddevice), so this is a simple
// toggle call.  The UI updates arrive back via window.__onPythonEvent.
micBtn.addEventListener("click", () => {
  if (typeof pywebview === "undefined" || !pywebview.api) return;
  pywebview.api.toggle_recording();
});

/* ── Keyboard shortcuts ───────────────────────────────────────────────────── */
document.addEventListener("keydown", (e) => {
  const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);

  if (IS_FAVORITES_VIEW) {
    if (e.key === "Escape") {
      e.preventDefault();
      _closeFavoritesWindow();
    }
    return;
  }

  if (_favoritesOverlayOpen) {
    if (e.key === "Escape") {
      e.preventDefault();
      _closeFavoritesOverlay();
    }
    return;
  }

  // ⌃⌘A — toggle recording (when window is focused)
  if (e.metaKey && e.ctrlKey && e.key === "a" && !e.altKey && !e.shiftKey) {
    if (inInput) return;
    e.preventDefault();
    pywebview.api.toggle_recording();
    return;
  }

  // Space — pause / resume
  if (e.key === " " && isRecording) {
    if (inInput) return;
    e.preventDefault();
    pywebview.api.pause_recording();
    return;
  }

  // Enter — stop & send
  if (e.key === "Enter" && isRecording) {
    if (inInput) return;
    e.preventDefault();
    pywebview.api.toggle_recording();
    return;
  }
});

nodesBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (IS_FAVORITES_VIEW) {
    return;
  }
  _whenApiReady(() => {
    if (pywebview.api && pywebview.api.toggle_favorites_overlay) {
      pywebview.api.toggle_favorites_overlay();
    }
  });
});

/* ── Voice bubble ─────────────────────────────────────────────────────────── */
const _ICON_EDIT = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8.5 1.5 10.5 3.5 4 10 1.5 10.5 2 8 8.5 1.5Z"/>
</svg>`;

function _normalizeTranscriptionRecord(record) {
  if (record == null) return null;
  if (typeof record === "string") {
    const text = record.trim();
    return text ? { text, favorite: false, id: null } : null;
  }
  const text = String(record.text ?? "").trim();
  if (!text) return null;
  return {
    id: record.id ?? null,
    text,
    source: record.source || "unknown",
    duration_ms: record.duration_ms ?? null,
    model: record.model ?? null,
    is_local: !!record.is_local,
    favorite: !!record.favorite,
    created_at: record.created_at || null,
  };
}

function _syncFavoriteButton(button, favorite) {
  if (!button) return;
  button.classList.toggle("active", !!favorite);
  button.setAttribute("aria-pressed", favorite ? "true" : "false");
  button.setAttribute("aria-label", favorite ? "Remove favorite" : "Favorite note");
  button.title = favorite ? "Remove favorite" : "Favorite note";
}

function _makeFavoriteButton(favorite = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "favorite-btn";
  _syncFavoriteButton(button, favorite);
  return button;
}

function _renderVoiceBubbleBody(bubble, text, favoriteBtn = null, favorite = false, transcriptionId = null) {
  bubble.dataset.rawText = text;
  bubble.dataset.favorite = favorite ? "1" : "0";
  if (transcriptionId != null) {
    bubble.dataset.transcriptionId = String(transcriptionId);
  }
  bubble.classList.toggle("favorited", !!favorite);

  bubble.innerHTML = "";
  const textEl = document.createElement("span");
  textEl.className = "voice-text";
  textEl.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
  bubble.appendChild(textEl);

  if (favoriteBtn) {
    bubble.appendChild(favoriteBtn);
    _syncFavoriteButton(favoriteBtn, favorite);
  }
}

function _createVoiceBubble(record, options = {}) {
  const {
    mode = "main",
    onFocus = null,
    onFavoriteChanged = null,
  } = options || {};
  const normalized = _normalizeTranscriptionRecord(record);
  if (!normalized) return null;

  const wrap = document.createElement("div");
  wrap.className = "msg-wrap voice-wrap";
  if (mode !== "main") {
    wrap.classList.add("nodes-note-wrap");
  }

  const bubble = document.createElement("div");
  bubble.className = "msg voice";
  bubble.dataset.mode = mode;
  bubble.title = mode === "main" ? "Click to copy" : "Click to copy, double-click to edit";
  if (mode !== "main") {
    bubble.classList.add("nodes-note");
  }
  const favoriteBtn = _makeFavoriteButton(normalized.favorite);
  if (normalized.id == null) {
    favoriteBtn.disabled = true;
    favoriteBtn.title = "Saved notes only";
  }
  favoriteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (favoriteBtn.disabled) return;
    await _toggleFavoriteBubble(bubble, favoriteBtn, {
      onChanged: (favorite, updated) => {
        if (typeof onFavoriteChanged === "function") {
          onFavoriteChanged({
            favorite,
            updated,
            record: _normalizeTranscriptionRecord(updated || record) || normalized,
          });
        }
      },
    });
  });

  if (mode === "main") {
    bubble.addEventListener("click", () => {
      navigator.clipboard.writeText(bubble.dataset.rawText || bubble.textContent.trim())
        .catch(() => {});
      bubble.classList.add("bubble-copied");
      setTimeout(() => bubble.classList.remove("bubble-copied"), 700);
    });
  } else if (typeof onFocus === "function") {
    let clickTimer = null;
    const copyBubble = () => {
      navigator.clipboard.writeText(bubble.dataset.rawText || bubble.textContent.trim())
        .catch(() => {});
      bubble.classList.add("bubble-copied");
      setTimeout(() => bubble.classList.remove("bubble-copied"), 700);
    };
    bubble.addEventListener("click", (e) => {
      e.stopPropagation();
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        copyBubble();
      }, 180);
    });
    bubble.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      onFocus({
        record: normalized,
        wrap,
        bubble,
        favoriteBtn,
      });
    });
  }

  _renderVoiceBubbleBody(bubble, normalized.text, favoriteBtn, normalized.favorite, normalized.id);
  if (normalized.favorite) {
    bubble.classList.add("favorited");
  }

  if (mode === "main") {
    const acts = document.createElement("div");
    acts.className = "msg-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "action-btn";
    editBtn.title = "Edit";
    editBtn.innerHTML = _ICON_EDIT;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startEditBubble(bubble, wrap);
    });
    acts.appendChild(editBtn);

    wrap.appendChild(acts);
  }
  wrap.appendChild(bubble);
  wrap.dataset.transcriptionId = normalized.id != null ? String(normalized.id) : "";
  bubble.dataset.transcriptionId = normalized.id != null ? String(normalized.id) : "";
  return { wrap, bubble, favoriteBtn, record: normalized };
}

async function _toggleFavoriteBubble(bubble, favoriteBtn, options = {}) {
  const { onChanged = null } = options || {};
  if (typeof pywebview === "undefined" || !pywebview.api || !bubble.dataset.transcriptionId) {
    showSystem("This note has not been saved yet.");
    return;
  }

  const transcriptionId = Number(bubble.dataset.transcriptionId);
  const nextFavorite = !bubble.classList.contains("favorited");
  bubble.classList.toggle("favorited", nextFavorite);
  bubble.dataset.favorite = nextFavorite ? "1" : "0";
  _syncFavoriteButton(favoriteBtn, nextFavorite);

  try {
    const updated = await pywebview.api.toggle_transcription_favorite(transcriptionId, nextFavorite);
    const confirmed = !!(updated && updated.favorite);
    bubble.classList.toggle("favorited", confirmed);
    bubble.dataset.favorite = confirmed ? "1" : "0";
    _syncFavoriteButton(favoriteBtn, confirmed);
    if (typeof onChanged === "function") {
      onChanged(confirmed, updated || null);
    }
  } catch (e) {
    const reverted = !nextFavorite;
    bubble.classList.toggle("favorited", reverted);
    bubble.dataset.favorite = reverted ? "1" : "0";
    _syncFavoriteButton(favoriteBtn, reverted);
    showSystem((e && e.message) || "Could not update favorite.");
  }
}

function appendVoiceBubble(record, { scroll = true } = {}) {
  const item = _createVoiceBubble(record);
  if (!item) return null;
  if (item.record && item.record.id != null) {
    _historyItemsById.set(String(item.record.id), item);
  }
  _clearHistoryEmpty();
  messages.appendChild(item.wrap);
  if (scroll) scrollBottom();
  return item.bubble;
}

function startEditBubble(bubble, wrap, options = {}) {  // eslint-disable-line no-unused-vars
  const {
    onSave = null,
    onCancel = null,
    onEscape = null,
  } = options || {};
  if (bubble.classList.contains("editing")) return;
  bubble.classList.add("editing");
  const isConstrainedCard = !!bubble.closest(".nodes-grid-item") || !!bubble.closest(".nodes-focus-wrap");

  const originalText = bubble.dataset.rawText || bubble.textContent.trim();
  const transcriptionId = bubble.dataset.transcriptionId;
  const favoriteBtn = bubble.querySelector(".favorite-btn");
  const currentFavorite = bubble.classList.contains("favorited");

  const ta = document.createElement("textarea");
  ta.className = "msg-edit-textarea";
  ta.value = originalText;
  ta.rows = 1;

  const btnRow = document.createElement("div");
  btnRow.className = "msg-edit-btns";

  const saveBtn = document.createElement("button");
  saveBtn.className = "msg-edit-save";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "msg-edit-cancel";
  cancelBtn.textContent = "Cancel";

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);

  bubble.innerHTML = "";
  bubble.appendChild(ta);
  bubble.appendChild(btnRow);

  if (isConstrainedCard) {
    ta.style.flex = "1 1 auto";
    ta.style.minHeight = "0";
    ta.style.overflowY = "auto";
    ta.style.overflowX = "hidden";
  } else {
    const resize = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    ta.addEventListener("input", resize);
    resize();
  }
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveBtn.click(); }
    if (e.key === "Escape") {
      e.preventDefault();
      if (typeof onEscape === "function") {
        onEscape({
          bubble,
          wrap,
          transcriptionId: transcriptionId ? Number(transcriptionId) : null,
          text: ta.value.trim(),
          favorite: currentFavorite,
        });
      } else {
        cancelBtn.click();
      }
    }
  });

  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    bubble.classList.remove("editing");
    _renderVoiceBubbleBody(
      bubble,
      originalText,
      favoriteBtn,
      currentFavorite,
      transcriptionId ? Number(transcriptionId) : null,
    );
    if (typeof onCancel === "function") {
      onCancel({
        bubble,
        wrap,
        transcriptionId: transcriptionId ? Number(transcriptionId) : null,
        text: originalText,
        favorite: currentFavorite,
      });
    }
  });

  saveBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const newText = ta.value.trim();
    bubble.classList.remove("editing");
    _renderVoiceBubbleBody(
      bubble,
      newText,
      favoriteBtn,
      currentFavorite,
      transcriptionId ? Number(transcriptionId) : null,
    );
    if (transcriptionId && typeof pywebview !== "undefined" && pywebview.api && pywebview.api.update_transcription_text) {
      pywebview.api.update_transcription_text(Number(transcriptionId), newText)
        .then((updated) => {
          if (updated && updated.text) {
            bubble.dataset.rawText = updated.text;
            _renderVoiceBubbleBody(
              bubble,
              updated.text,
              favoriteBtn,
              currentFavorite,
              transcriptionId ? Number(transcriptionId) : null,
            );
          }
          if (typeof onSave === "function") {
            onSave({
              bubble,
              wrap,
              transcriptionId: transcriptionId ? Number(transcriptionId) : null,
              text: updated && updated.text ? updated.text : newText,
              favorite: currentFavorite,
              updated: updated || null,
            });
          }
        })
        .catch((e) => showSystem((e && e.message) || "Could not save note changes."));
    } else if (typeof onSave === "function") {
      onSave({
        bubble,
        wrap,
        transcriptionId: transcriptionId ? Number(transcriptionId) : null,
        text: newText,
        favorite: currentFavorite,
        updated: null,
      });
    }
  });
}

function _closeFavoritesWindow() {
  if (_apiReady() && pywebview.api.hide_favorites_overlay) {
    pywebview.api.hide_favorites_overlay();
  }
}

function _syncFavoritesOverlayCount(total = null) {
  if (!nodesCount) return;
  const count = total == null ? _favoritesOverlayItemsById.size : total;
  if (count === 1) {
    nodesCount.textContent = "1 favorite";
  } else {
    nodesCount.textContent = `${count} favorites`;
  }
}

function _clearFavoritesOverlayFocus() {
  if (_favoritesOverlayFocusedWrap) {
    _favoritesOverlayFocusedWrap.remove();
    _favoritesOverlayFocusedWrap = null;
  }
  if (_favoritesOverlayFocusedId != null) {
    const item = _favoritesOverlayItemsById.get(String(_favoritesOverlayFocusedId));
    if (item) {
      item.wrap.classList.remove("nodes-grid-item-dimmed");
    }
  }
  _favoritesOverlayFocusedId = null;
  if (nodesFocusStage) {
    nodesFocusStage.innerHTML = "";
  }
}

function _removeFavoritesOverlayItem(transcriptionId) {
  const id = String(transcriptionId);
  const item = _favoritesOverlayItemsById.get(id);
  if (!item) return;
  if (_favoritesOverlayFocusedId === id) {
    _clearFavoritesOverlayFocus();
  }
  item.wrap.remove();
  _favoritesOverlayItemsById.delete(id);
  if (_favoritesOverlayOpen) {
    _syncFavoritesOverlayCount();
    if (_favoritesOverlayItemsById.size === 0) {
      _renderFavoritesOverlayEmpty();
    }
  }
}

function _renderFavoritesOverlayEmpty(message = "No favorites yet. Turn on the LED on a note to pin it here.") {
  if (!nodesGrid) return;
  nodesGrid.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "nodes-empty";
  empty.textContent = message;
  nodesGrid.appendChild(empty);
  _syncFavoritesOverlayCount(0);
}

function _renderFavoritesOverlayRows(rows) {
  if (!nodesGrid) return;
  _favoritesOverlayItemsById.clear();
  nodesGrid.innerHTML = "";

  const normalizedRows = Array.isArray(rows)
    ? rows.map((row) => _normalizeTranscriptionRecord(row)).filter(Boolean)
    : [];

  if (normalizedRows.length === 0) {
    _renderFavoritesOverlayEmpty();
    return;
  }

  const frag = document.createDocumentFragment();
  normalizedRows.forEach((row, index) => {
    const item = _createVoiceBubble(row, {
      mode: "overlay",
      onFocus: (payload) => _focusFavoriteOverlayItem(payload),
      onFavoriteChanged: ({ favorite, updated, record }) => {
        const id = String((record && record.id) || row.id);
        if (!favorite) {
          _removeFavoritesOverlayItem(id);
          return;
        }
        const existing = _favoritesOverlayItemsById.get(id);
        if (!existing) return;
        const nextRecord = _normalizeTranscriptionRecord(updated || record || row);
        if (!nextRecord) return;
        existing.record = nextRecord;
        _renderVoiceBubbleBody(
          existing.bubble,
          nextRecord.text,
          existing.favoriteBtn,
          nextRecord.favorite,
          nextRecord.id,
        );
      },
    });
    if (!item) return;
    item.wrap.classList.add("nodes-grid-item");
    item.wrap.style.setProperty("--enter-delay", `${index * 34}ms`);
    item.record = row;
    _favoritesOverlayItemsById.set(String(row.id), item);
    frag.appendChild(item.wrap);
  });

  nodesGrid.appendChild(frag);
  _syncFavoritesOverlayCount(normalizedRows.length);
}

function _openFavoritesOverlay() {
  if (IS_FAVORITES_VIEW) {
    nodesOverlay.hidden = false;
    _favoritesOverlayOpen = true;
    document.body.classList.add("favorites-overlay-open");
    nodesOverlay.classList.add("open");
    _loadFavoritesOverlay();
    return;
  }
  if (typeof pywebview !== "undefined" && pywebview.api && pywebview.api.show_favorites_overlay) {
    pywebview.api.show_favorites_overlay();
  }
}

function _closeFavoritesOverlay() {
  if (!IS_FAVORITES_VIEW) {
    if (typeof pywebview !== "undefined" && pywebview.api && pywebview.api.hide_favorites_overlay) {
      pywebview.api.hide_favorites_overlay();
    }
    return;
  }
  if (!_favoritesOverlayOpen) return;
  _favoritesOverlayOpen = false;
  document.body.classList.remove("favorites-overlay-open");
  _clearFavoritesOverlayFocus();
  nodesOverlay.classList.remove("open");
  if (_favoritesOverlayCloseTimer) {
    clearTimeout(_favoritesOverlayCloseTimer);
  }
  _favoritesOverlayCloseTimer = setTimeout(() => {
    if (!nodesOverlay.classList.contains("open")) {
      nodesOverlay.hidden = true;
    }
    _favoritesOverlayCloseTimer = null;
    if (typeof pywebview !== "undefined" && pywebview.api && pywebview.api.hide_favorites_overlay) {
      pywebview.api.hide_favorites_overlay();
    }
  }, 220);
}

async function _loadFavoritesOverlay() {
  const token = ++_favoritesOverlayLoadToken;
  if (typeof pywebview === "undefined" || !pywebview.api || !pywebview.api.get_favorite_transcriptions) {
    _renderFavoritesOverlayEmpty("Loading favorite notes…");
    if (_favoritesLoadRetryTimer) clearTimeout(_favoritesLoadRetryTimer);
    _favoritesLoadRetryTimer = setTimeout(() => {
      if (_favoritesOverlayOpen) _loadFavoritesOverlay();
    }, 60);
    return;
  }

  if (_favoritesLoadRetryTimer) {
    clearTimeout(_favoritesLoadRetryTimer);
    _favoritesLoadRetryTimer = null;
  }

  try {
    const rows = await pywebview.api.get_favorite_transcriptions();
    if (token !== _favoritesOverlayLoadToken || !_favoritesOverlayOpen) return;
    _renderFavoritesOverlayRows(rows);
  } catch (e) {
    if (token !== _favoritesOverlayLoadToken || !_favoritesOverlayOpen) return;
    const message = (e && e.message) || "Could not load favorite notes.";
    _renderFavoritesOverlayEmpty(message);
  }
}

function _focusFavoriteOverlayItem(payload) {
  if (!_favoritesOverlayOpen || !payload || !payload.record || payload.record.id == null) return;

  const id = String(payload.record.id);
  const current = _favoritesOverlayItemsById.get(id);
  if (!current) return;

  if (_favoritesOverlayFocusedId === id) {
    return;
  }

  _clearFavoritesOverlayFocus();

  const rect = current.wrap.getBoundingClientRect();
  const focusItem = _createVoiceBubble(current.record, {
    mode: "focus",
    onFavoriteChanged: ({ favorite, updated, record }) => {
      const nextRecord = _normalizeTranscriptionRecord(updated || record || current.record);
      if (!favorite) {
        _removeFavoritesOverlayItem(id);
        return;
      }
      if (!nextRecord) return;
      const item = _favoritesOverlayItemsById.get(id);
      if (!item) return;
      item.record = nextRecord;
      _renderVoiceBubbleBody(
        item.bubble,
        nextRecord.text,
        item.favoriteBtn,
        nextRecord.favorite,
        nextRecord.id,
      );
      if (_favoritesOverlayFocusedId === id && _favoritesOverlayFocusedWrap) {
        const focusedBubble = _favoritesOverlayFocusedWrap.querySelector(".msg.voice");
        if (focusedBubble) {
          focusedBubble.dataset.rawText = nextRecord.text;
        }
      }
    },
  });
  if (!focusItem) return;

  const focusWrap = focusItem.wrap;
  focusWrap.classList.add("nodes-focus-wrap");
  focusWrap.style.left = `${rect.left}px`;
  focusWrap.style.top = `${rect.top}px`;
  focusWrap.style.width = `${rect.width}px`;
  focusWrap.style.minHeight = `${rect.height}px`;
  focusWrap.style.opacity = "0";

  nodesFocusStage.innerHTML = "";
  nodesFocusStage.appendChild(focusWrap);
  current.wrap.classList.add("nodes-grid-item-dimmed");
  _favoritesOverlayFocusedId = id;
  _favoritesOverlayFocusedWrap = focusWrap;

  requestAnimationFrame(() => {
    focusWrap.style.opacity = "1";
    focusWrap.classList.add("is-focused");
  });

  window.setTimeout(() => {
    if (!_favoritesOverlayOpen || _favoritesOverlayFocusedId !== id || !_favoritesOverlayFocusedWrap) return;
    startEditBubble(focusItem.bubble, focusWrap, {
      onSave: ({ text }) => {
        const item = _favoritesOverlayItemsById.get(id);
        if (!item) return;
        item.record = {
          ...item.record,
          text,
        };
        _renderVoiceBubbleBody(
          item.bubble,
          text,
          item.favoriteBtn,
          item.record.favorite,
          item.record.id,
        );
      },
      onEscape: () => {
        _closeFavoritesOverlay();
      },
    });
  }, 220);
}

let _historyLoaded = false;
function _loadSavedTranscriptions({ preserveScroll = false, scrollTop = 0 } = {}) {
  if (_historyLoaded) return;
  if (typeof pywebview === "undefined" || !pywebview.api || !pywebview.api.get_transcription_history) return;
  _historyLoaded = true;
  pywebview.api.get_transcription_history().then((rows) => {
    messages.innerHTML = "";
    _historyItemsById.clear();
    _clearHistoryEmpty();
    if (!Array.isArray(rows) || rows.length === 0) {
      _renderHistoryEmpty("No notes in this history window.");
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const item = _createVoiceBubble(row);
      if (item) {
        if (item.record && item.record.id != null) {
          _historyItemsById.set(String(item.record.id), item);
        }
        frag.appendChild(item.wrap);
      }
    }
    messages.appendChild(frag);
    if (preserveScroll) {
      const maxScrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
      messages.scrollTop = Math.min(scrollTop, maxScrollTop);
    } else {
      scrollBottom();
    }
  }).catch((e) => {
    _historyLoaded = false;
    _clearHistoryEmpty();
    showSystem((e && e.message) || "Could not load saved notes.");
  });
}

function _scheduleHistoryLoad(options = {}) {
  if (typeof pywebview !== "undefined" && pywebview.api && pywebview.api.get_transcription_history) {
    _loadSavedTranscriptions(options);
    return;
  }
  window.addEventListener("pywebviewready", () => _loadSavedTranscriptions(options), { once: true });
}

function _scheduleFavoritesLoad() {
  if (IS_FAVORITES_VIEW) {
    _loadFavoritesPage();
    return;
  }
  _loadFavoritesOverlay();
}

/* ── Window open / close animations ─────────────────────────────────────── */
function _startOpenAnimation() {
  const start = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.remove("pre-open");
        document.body.classList.add("opening");
      });
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}

_startOpenAnimation();

if (IS_FAVORITES_VIEW) {
  _loadFavoritesPage();
} else {
  _scheduleHistoryLoad();
}

document.body.addEventListener("animationend", function onOpen(e) {
  if (e.animationName === "windowOpen") {
    document.body.classList.remove("opening");
    document.body.removeEventListener("animationend", onOpen);
  }
});

let _closeInFlight = false;

/* ── Close button ─────────────────────────────────────────────────────────── */
closeBtn.addEventListener("click", () => {
  if (IS_FAVORITES_VIEW) {
    _closeFavoritesWindow();
    return;
  }
  if (_closeInFlight) return;
  _closeInFlight = true;
  document.body.classList.add("closing");
  setTimeout(() => {
    if (typeof pywebview !== "undefined" && pywebview.api && pywebview.api.close_window) {
      pywebview.api.close_window();
    }
  }, 190);
});

/* ── Settings ─────────────────────────────────────────────────────────────── */
settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (_favoritesOverlayOpen) {
    _closeFavoritesOverlay();
  }
  if (settingsOverlay.style.display === "none") {
    settingsOverlay.style.display = "flex";
    settingsBtn.classList.add("open");
    _whenApiReady(() => {
      pywebview.api.get_settings().then((s) => {
        localWhisperModelSel.value           = s.local_whisper_model || "small";
        transcriberIpInput.value             = s.transcriber_ip || "";
        transcriberPortInput.value           = s.transcriber_port || "9000";
        transcriberModelSel.value            = s.transcriber_model || "medium";
        transcriberFallbackIpInput.value     = s.transcriber_fallback_ip || "";
        transcriberFallbackPortInput.value   = s.transcriber_fallback_port || "9000";
        transcriberFallbackModelSel.value    = s.transcriber_fallback_model || "medium";
        alwaysOnTopToggle.checked            = s.always_on_top !== false;
        useHostedWhisperToggle.checked       = s.use_hosted_whisper !== false;
        useLocalFallbackToggle.checked       = s.use_local_fallback !== false;
        languageSelect.value                 = s.transcription_language || "auto";
        historyWindowSelect.value            = s.history_window || "all";
      }).catch((e) => {
        showSystem((e && e.message) || "Could not load settings.");
      });
    });
  } else {
    settingsOverlay.style.display = "none";
    settingsBtn.classList.remove("open");
  }
});

settingsClose.addEventListener("click", () => {
  settingsOverlay.style.display = "none";
  settingsBtn.classList.remove("open");
});

settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) {
    settingsOverlay.style.display = "none";
    settingsBtn.classList.remove("open");
  }
});

nodesBackdrop.addEventListener("click", _closeFavoritesOverlay);
nodesClose.addEventListener("click", _closeFavoritesOverlay);

settingsSave.addEventListener("click", async () => {
  if (!useHostedWhisperToggle.checked && !useLocalFallbackToggle.checked) {
    showSystem("Enable hosted or local transcription.");
    return;
  }
  try {
    if (!_apiReady() || !pywebview.api.save_settings) {
      showSystem("WhisperNote is still starting up. Try again in a moment.");
      return;
    }
    await pywebview.api.save_settings({
      local_whisper_model:       localWhisperModelSel.value,
      transcriber_ip:            transcriberIpInput.value,
      transcriber_port:          transcriberPortInput.value,
      transcriber_model:         transcriberModelSel.value,
      transcriber_fallback_ip:   transcriberFallbackIpInput.value,
      transcriber_fallback_port: transcriberFallbackPortInput.value,
      transcriber_fallback_model: transcriberFallbackModelSel.value,
      always_on_top:             alwaysOnTopToggle.checked,
      use_hosted_whisper:        useHostedWhisperToggle.checked,
      use_local_fallback:        useLocalFallbackToggle.checked,
      transcription_language:    languageSelect.value,
      history_window:            historyWindowSelect.value,
    });
    settingsOverlay.style.display = "none";
    settingsBtn.classList.remove("open");
    _refreshHistoryLoad();
  } catch (e) {
    showSystem((e && e.message) || "Enable hosted or local transcription.");
  }
});

/* ── Info hover/focus handling ────────────────────────────────────────────── */
if (infoBtn && helpCard) {
  const showHelp = () => helpCard.classList.add("open");
  const hideHelp = () => helpCard.classList.remove("open");
  infoBtn.addEventListener("mouseenter", showHelp);
  infoBtn.addEventListener("mouseleave", hideHelp);
  infoBtn.addEventListener("focus", showHelp);
  infoBtn.addEventListener("blur", hideHelp);
}

/* ── Drag and drop ───────────────────────────────────────────────────────── */
const _SUPPORTED_EXTS = [".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aiff", ".aif"];

function _isAudioFile(file) {
  const name = file.name || file;
  const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
  return _SUPPORTED_EXTS.includes(ext);
}

let _dragCounter = 0;

document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  _dragCounter++;
  document.body.classList.add("drag-over");
}, { passive: false });

document.addEventListener("dragleave", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  _dragCounter--;
  if (_dragCounter === 0) {
    document.body.classList.remove("drag-over");
  }
}, { passive: false });

document.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
}, { passive: false });

document.addEventListener("drop", async (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  _dragCounter = 0;
  document.body.classList.remove("drag-over");

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const audioFile = Array.from(files).find(f => _isAudioFile(f.name));
  if (!audioFile) {
    showSystem("Drop an audio file: wav, mp3, m4a, flac, ogg, aiff");
    return;
  }

  if (typeof pywebview === "undefined" || !pywebview.api) return;
  if (isRecording) {
    showSystem("Finish recording first");
    return;
  }

  const ext = audioFile.name.substring(audioFile.name.lastIndexOf(".")).toLowerCase();
  const arrayBuffer = await audioFile.arrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  pywebview.api.transcribe_file_bytes(audioFile.name, ext, bytes);
}, { passive: false });
