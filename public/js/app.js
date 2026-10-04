/**
 * SMART FIRE GUARD - FRONTEND CLIENT APPLICATION
 * Real-time WebSockets & REST API Integration
 */

const $ = id => document.getElementById(id);

let soundEnabled = true;
let audioCtx = null;
let buzzerOscillator = null;
let buzzerGain = null;

// Initialize Web Audio API Buzzer Alarm
function initAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();
  }
}

function startBuzzerSound() {
  if (!soundEnabled) return;
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  if (!buzzerOscillator) {
    try {
      buzzerOscillator = audioCtx.createOscillator();
      buzzerGain = audioCtx.createGain();

      buzzerOscillator.type = 'sawtooth';
      buzzerOscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz pitch

      // Beep pulse
      buzzerGain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      
      buzzerOscillator.connect(buzzerGain);
      buzzerGain.connect(audioCtx.destination);
      buzzerOscillator.start();
    } catch (e) {
      console.warn("Audio Context init block:", e);
    }
  }
}

function stopBuzzerSound() {
  if (buzzerOscillator) {
    try {
      buzzerOscillator.stop();
      buzzerOscillator.disconnect();
    } catch (e) {}
    buzzerOscillator = null;
  }
}

// ------------------------------------------------------------------
// SOCKET.IO REALTIME LISTENER
// ------------------------------------------------------------------
const socket = io();

socket.on('connect', () => {
  console.log('Connected to Smart Fire Guard WebSocket Server');
  fetchStatus();
  fetchLogs();
});

socket.on('sensor_update', (data) => {
  if (data && data.state) {
    updateUI(data.state);
  }
  fetchLogs();
});

socket.on('logs_cleared', () => {
  fetchLogs();
});

// ------------------------------------------------------------------
// UI UPDATER
// ------------------------------------------------------------------
const txtMap = { ok: "Normal", warn: "Warning", bad: "DANGER" };

function setCard(cardId, sid, level) {
  const cardEl = $(cardId);
  if (!cardEl) return;
  cardEl.classList.toggle("alert", level === "bad");
  const s = $(sid);
  if (s) {
    s.className = "s " + level;
    s.textContent = txtMap[level] || "Normal";
  }
}

function lvl(v, warnThresh, dangerThresh) {
  return v > dangerThresh ? "bad" : v > warnThresh ? "warn" : "ok";
}

function updateUI(state) {
  const T = state.temperature || 32;
  const S = state.smoke || 12;
  const G = state.gas || 5;
  const fire = state.fire || state.flame || state.level === 'bad';

  const lt = lvl(T, 45, 60);
  const ls = lvl(S, 30, 60);
  const lg = lvl(G, 30, 60);
  const overallLv = state.level || (fire ? "bad" : (lt === "bad" || ls === "bad" || lg === "bad") ? "bad" : (lt === "warn" || ls === "warn" || lg === "warn") ? "warn" : "ok");

  // Temperature & Smoke Cards
  if ($("t")) $("t").textContent = T.toFixed(0) + "°C";
  if ($("s")) $("s").textContent = S.toFixed(0) + "%";
  setCard("c-t", "t-s", lt);
  setCard("c-s", "s-s", ls);

  // Flame & AI Status
  if ($("f")) {
    $("f").textContent = fire ? "FIRE!" : "NORMAL";
    $("f").className = "v " + (fire ? "bad" : "");
  }
  if ($("c-f")) $("c-f").classList.toggle("alert", fire);

  if ($("a")) {
    $("a").textContent = fire ? "FIRE" : "NORMAL";
    $("a").className = "v " + (fire ? "bad" : "");
  }
  if ($("c-a")) $("c-a").classList.toggle("alert", fire);

  // Dashboard quick view text
  if ($("d-t")) $("d-t").textContent = T.toFixed(0) + "°C";
  if ($("d-s")) $("d-s").textContent = S.toFixed(0) + "%";
  if ($("d-f")) $("d-f").textContent = fire ? "FLAME DETECTED" : "Normal";
  if ($("d-g")) $("d-g").textContent = txtMap[lg] || "Normal";

  // Sensors progress bars
  if ($("b-t")) $("b-t").textContent = T.toFixed(1) + "°C";
  if ($("b-s")) $("b-s").textContent = S.toFixed(0) + "%";
  if ($("b-g")) $("b-g").textContent = G.toFixed(0) + "%";

  if ($("p-t")) $("p-t").style.width = Math.min(100, (T / 100) * 100) + "%";
  if ($("p-s")) $("p-s").style.width = Math.min(100, S) + "%";
  if ($("p-g")) $("p-g").style.width = Math.min(100, G) + "%";

  ["p-t", "p-s", "p-g"].forEach((id, i) => {
    const el = $(id);
    if (!el) return;
    const itemLvl = [lt, ls, lg][i];
    el.style.background = itemLvl === "bad" ? "var(--bad)" : itemLvl === "warn" ? "var(--warn)" : "var(--ok)";
  });

  // Camera alert outlines & Bounding Boxes
  ["cam1", "cam2"].forEach(camId => {
    const cam = $(camId);
    if (cam) cam.classList.toggle("fire", fire);
  });

  const aiText = state.aiResult ? state.aiResult.statusText : (fire ? "AI Detection: 🚨 FIRE DETECTED (độ tin cậy 94%)" : "AI Detection: ✓ No fire detected");
  if ($("det")) $("det").textContent = aiText;
  if ($("det2")) $("det2").textContent = aiText;

  // Header status pill
  const sys = $("sys");
  if (sys) {
    sys.className = "pill" + (overallLv === "bad" ? " bad" : "");
    sys.textContent = overallLv === "bad" ? "🔴 FIRE ALERT" : overallLv === "warn" ? "🟠 WARNING" : "🟢 SYSTEM ONLINE";
  }

  // ESP32 Hardware Status Badge
  const hwPill = $("hw-status");
  if (hwPill) {
    if (state.esp32Connected) {
      hwPill.className = "pill hw-pill online";
      hwPill.textContent = "📡 ESP32: ONLINE";
    } else {
      hwPill.className = "pill hw-pill";
      hwPill.textContent = "💻 ESP32: OFFLINE (Giả lập)";
    }
  }

  // Active Alert Banner
  const activeEl = $("active");
  if (activeEl) {
    activeEl.innerHTML = overallLv === "ok" 
      ? "Không có cảnh báo hoạt động. Hệ thống an toàn." 
      : `<b class="${overallLv}">${overallLv === "bad" ? "🚨 NGUY HIỂM: NGUY CƠ CHÁY CAO!" : "⚠️ CẢNH BÁO: CHỈ SỐ BẤT THƯỜNG"}</b><br>Nhiệt độ ${T.toFixed(1)}°C · Khói ${S.toFixed(0)}% · Gas ${G.toFixed(0)}% · Nguồn: ${state.source || 'Hệ thống'}`;
  }

  // Trigger Sound Alarm
  if (overallLv === "bad") {
    startBuzzerSound();
  } else {
    stopBuzzerSound();
  }
}

// ------------------------------------------------------------------
// REST API FETCHERS & CONTROLLERS
// ------------------------------------------------------------------
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.success && data.state) {
      updateUI(data.state);
    }
  } catch (err) {
    console.error("Error fetching status:", err);
  }
}

async function fetchLogs() {
  try {
    const res = await fetch('/api/logs');
    const data = await res.json();
    if (data.success && data.logs) {
      const logBody = $("log");
      if (logBody) {
        logBody.innerHTML = data.logs.map(r => `
          <tr>
            <td>${r.formatted_time || r.timestamp}</td>
            <td class="${r.level === 'DANGER' ? 'bad' : r.level === 'WARN' ? 'warn' : 'ok'}">${r.level}</td>
            <td>${r.message}</td>
          </tr>
        `).join("");
      }
    }
  } catch (err) {
    console.error("Error fetching logs:", err);
  }
}

// Simulate Fire Button
if ($("sim")) {
  $("sim").onclick = async () => {
    initAudio();
    await fetch('/api/simulate/fire', { method: 'POST' });
    fetchStatus();
  };
}

// Reset System Button
if ($("rst")) {
  $("rst").onclick = async () => {
    await fetch('/api/reset', { method: 'POST' });
    fetchStatus();
  };
}

// Clear Logs Button
if ($("clear-log-btn")) {
  $("clear-log-btn").onclick = async () => {
    if (confirm("Bạn có chắc chắn muốn xóa tất cả lịch sử cảnh báo?")) {
      await fetch('/api/logs/clear', { method: 'POST' });
      fetchLogs();
    }
  };
}

// Sound Toggle Button
if ($("btn-sound")) {
  $("btn-sound").onclick = () => {
    soundEnabled = !soundEnabled;
    $("btn-sound").textContent = soundEnabled ? "🔊 Âm thanh còi: Đang Bật" : "🔇 Âm thanh còi: Đã Tắt";
    if (!soundEnabled) stopBuzzerSound();
  };
}

// Navigation Tabs Router
const nav = $("nav");
if (nav) {
  nav.onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === b.dataset.v));
  };
}

// Initial Fetch
fetchStatus();
fetchLogs();
