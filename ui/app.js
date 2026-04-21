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

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const messages                   = document.getElementById("messages");
const micBtn                     = document.getElementById("micBtn");
const micWrap                    = document.getElementById("micWrap");
const closeBtn                   = document.getElementById("closeBtn");
const infoBtn                    = document.getElementById("infoBtn");
const helpCard                   = document.getElementById("helpCard");
const settingsBtn                = document.getElementById("settingsBtn");
const settingsOverlay            = document.getElementById("settingsOverlay");
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
      if (data && data.trim()) {
        navigator.clipboard.writeText(data.trim()).catch(() => {});
        appendVoiceBubble(data.trim());
      }
      break;

    case "transcription_error":
      _removeTranscribingIndicator();
      showSystem(data || "transcription failed");
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

/* ── Voice bubble ─────────────────────────────────────────────────────────── */
const _ICON_EDIT = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8.5 1.5 10.5 3.5 4 10 1.5 10.5 2 8 8.5 1.5Z"/>
</svg>`;

function appendVoiceBubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg-wrap voice-wrap";

  const div = document.createElement("div");
  div.className       = "msg voice";
  div.innerHTML       = escapeHtml(text).replace(/\n/g, "<br>");
  div.dataset.rawText = text;
  div.title           = "Click to copy";

  div.addEventListener("click", () => {
    navigator.clipboard.writeText(div.dataset.rawText || div.textContent.trim())
      .catch(() => {});
    div.classList.add("bubble-copied");
    setTimeout(() => div.classList.remove("bubble-copied"), 700);
  });

  const acts    = document.createElement("div");
  acts.className = "msg-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "action-btn";
  editBtn.title     = "Edit";
  editBtn.innerHTML = _ICON_EDIT;
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startEditBubble(div, wrap);
  });
  acts.appendChild(editBtn);

  wrap.appendChild(acts);
  wrap.appendChild(div);
  messages.appendChild(wrap);
  scrollBottom();
  return div;
}

function startEditBubble(bubble, wrap) {  // eslint-disable-line no-unused-vars
  if (bubble.classList.contains("editing")) return;
  bubble.classList.add("editing");

  const originalText = bubble.dataset.rawText || bubble.textContent.trim();

  const ta = document.createElement("textarea");
  ta.className = "msg-edit-textarea";
  ta.value     = originalText;
  ta.rows      = 1;

  const btnRow    = document.createElement("div");
  btnRow.className = "msg-edit-btns";

  const saveBtn        = document.createElement("button");
  saveBtn.className    = "msg-edit-save";
  saveBtn.textContent  = "Save";

  const cancelBtn       = document.createElement("button");
  cancelBtn.className   = "msg-edit-cancel";
  cancelBtn.textContent = "Cancel";

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);

  bubble.innerHTML = "";
  bubble.appendChild(ta);
  bubble.appendChild(btnRow);

  const resize = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", resize);
  resize();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveBtn.click(); }
    if (e.key === "Escape") cancelBtn.click();
  });

  cancelBtn.addEventListener("click", () => {
    bubble.classList.remove("editing");
    bubble.innerHTML        = escapeHtml(originalText).replace(/\n/g, "<br>");
    bubble.dataset.rawText  = originalText;
  });

  saveBtn.addEventListener("click", () => {
    const newText = ta.value.trim();
    bubble.classList.remove("editing");
    bubble.innerHTML        = escapeHtml(newText).replace(/\n/g, "<br>");
    bubble.dataset.rawText  = newText;
  });
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

document.body.addEventListener("animationend", function onOpen(e) {
  if (e.animationName === "windowOpen") {
    document.body.classList.remove("opening");
    document.body.removeEventListener("animationend", onOpen);
  }
});

let _closeInFlight = false;

/* ── Close button ─────────────────────────────────────────────────────────── */
closeBtn.addEventListener("click", () => {
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
  if (settingsOverlay.style.display === "none") {
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
    });
    settingsOverlay.style.display = "flex";
    settingsBtn.classList.add("open");
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

settingsSave.addEventListener("click", async () => {
  if (!useHostedWhisperToggle.checked && !useLocalFallbackToggle.checked) {
    showSystem("Enable hosted or local transcription.");
    return;
  }
  try {
    await pywebview.api.save_settings({
    local_whisper_model:      localWhisperModelSel.value,
    transcriber_ip:           transcriberIpInput.value,
    transcriber_port:         transcriberPortInput.value,
    transcriber_model:        transcriberModelSel.value,
    transcriber_fallback_ip:  transcriberFallbackIpInput.value,
    transcriber_fallback_port: transcriberFallbackPortInput.value,
    transcriber_fallback_model: transcriberFallbackModelSel.value,
    always_on_top:            alwaysOnTopToggle.checked,
    use_hosted_whisper:       useHostedWhisperToggle.checked,
    use_local_fallback:       useLocalFallbackToggle.checked,
    transcription_language:   languageSelect.value,
    });
    settingsOverlay.style.display = "none";
    settingsBtn.classList.remove("open");
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

document.body.addEventListener("dragenter", (e) => {
  e.preventDefault();
  _dragCounter++;
  if (e.dataTransfer?.types?.includes("Files")) {
    document.body.classList.add("drag-over");
  }
});

document.body.addEventListener("dragleave", (e) => {
  e.preventDefault();
  _dragCounter--;
  if (_dragCounter === 0) {
    document.body.classList.remove("drag-over");
  }
});

document.body.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer?.types?.includes("Files")) {
    e.dataTransfer.dropEffect = "copy";
  }
});

document.body.addEventListener("drop", async (e) => {
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
});
