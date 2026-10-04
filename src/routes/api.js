const express = require('express');
const router = express.Router();
const db = require('../database');
const aiDetector = require('../ai-detector');

// In-memory current state cache
let currentState = {
  temperature: 32.0,
  smoke: 12.0,
  gas: 5.0,
  flame: false,
  fire: false,
  level: 'ok', // 'ok', 'warn', 'bad'
  lastLevel: 'ok',
  source: 'SIMULATION',
  esp32Connected: false,
  lastEsp32Ping: null,
  cameraUrl: '',
  aiResult: {
    hasFire: false,
    confidence: 99.2,
    statusText: 'AI Detection: ✓ No fire detected'
  }
};

// Thresholds
const THRESHOLDS = {
  temp: { warn: 45, danger: 60 },
  smoke: { warn: 30, danger: 60 },
  gas: { warn: 30, danger: 60 }
};

/**
 * Calculate system alarm level based on sensor readings
 */
function calculateLevel(temp, smoke, gas, flame, simulatedFire) {
  if (simulatedFire || flame || temp > THRESHOLDS.temp.danger || smoke > THRESHOLDS.smoke.danger || gas > THRESHOLDS.gas.danger) {
    return 'bad'; // DANGER
  }
  if (temp > THRESHOLDS.temp.warn || smoke > THRESHOLDS.smoke.warn || gas > THRESHOLDS.gas.warn) {
    return 'warn'; // WARNING
  }
  return 'ok'; // NORMAL
}

module.exports = function (io) {
  // Broadcaster helper
  async function broadcastUpdate(reason = 'update') {
    const level = calculateLevel(
      currentState.temperature,
      currentState.smoke,
      currentState.gas,
      currentState.flame,
      currentState.fire
    );

    currentState.level = level;

    // AI Check
    currentState.aiResult = aiDetector.analyzeFrame(null, {
      fire: currentState.fire,
      temperature: currentState.temperature,
      smoke: currentState.smoke,
      gas: currentState.gas,
      flame: currentState.flame
    });

    // Handle level transition and save event log to SQLite
    if (level !== currentState.lastLevel) {
      if (level === 'bad') {
        const msg = `🚨 BÁO ĐỘNG CHÁY! Nhiệt độ ${currentState.temperature.toFixed(1)}°C, Khói ${currentState.smoke.toFixed(0)}%, Gas ${currentState.gas.toFixed(0)}% [Nguồn: ${currentState.source}]`;
        await db.saveEventLog('DANGER', msg);
      } else if (level === 'warn') {
        const msg = `⚠️ CẢNH BÁO VƯỢT NGƯỠNG! Nhiệt độ ${currentState.temperature.toFixed(1)}°C, Khói ${currentState.smoke.toFixed(0)}%`;
        await db.saveEventLog('WARN', msg);
      } else {
        const msg = `✅ Hệ thống trở lại trạng thái an toàn bình thường.`;
        await db.saveEventLog('INFO', msg);
      }
      currentState.lastLevel = level;
    }

    // Save periodic sensor reading
    await db.saveSensorReading({
      temperature: currentState.temperature,
      smoke: currentState.smoke,
      gas: currentState.gas,
      flame: currentState.flame,
      status: level === 'bad' ? 'DANGER' : level === 'warn' ? 'WARN' : 'NORMAL',
      source: currentState.source
    });

    // Socket.io push to web clients
    io.emit('sensor_update', {
      state: currentState,
      reason
    });
  }

  // 1. ESP32 Sensor Data Receiver Endpoint (WiFi HTTP POST)
  router.post('/sensor-data', async (req, res) => {
    try {
      const { temperature, smoke, gas, flame } = req.body;

      if (temperature !== undefined) currentState.temperature = parseFloat(temperature);
      if (smoke !== undefined) currentState.smoke = parseFloat(smoke);
      if (gas !== undefined) currentState.gas = parseFloat(gas);
      if (flame !== undefined) currentState.flame = Boolean(flame);

      currentState.source = 'ESP32_HARDWARE';
      currentState.esp32Connected = true;
      currentState.lastEsp32Ping = new Date().toISOString();

      await broadcastUpdate('esp32_post');

      // Respond back to ESP32 with action commands (e.g. trigger local Buzzer / LED)
      res.json({
        success: true,
        status: currentState.level,
        alarmActive: currentState.level === 'bad',
        buzzerCommand: currentState.level === 'bad' ? 'BUZZER_ON' : 'BUZZER_OFF',
        ledCommand: currentState.level === 'bad' ? 'RED_BLINK' : currentState.level === 'warn' ? 'YELLOW_ON' : 'GREEN_ON'
      });
    } catch (err) {
      console.error('Error handling sensor POST:', err);
      res.status(500).json({ error: 'Server error parsing sensor data' });
    }
  });

  // 2. Get Current Live Status
  router.get('/status', (req, res) => {
    res.json({
      success: true,
      state: currentState,
      thresholds: THRESHOLDS
    });
  });

  // 3. Get Event History Logs
  router.get('/logs', async (req, res) => {
    try {
      const logs = await db.getRecentLogs(50);
      res.json({ success: true, logs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Simulate Fire Alarm (Dashboard button)
  router.post('/simulate/fire', async (req, res) => {
    currentState.fire = true;
    currentState.temperature = 75.0;
    currentState.smoke = 85.0;
    currentState.gas = 65.0;
    currentState.flame = true;
    currentState.source = 'SIMULATION';

    await broadcastUpdate('simulate_fire');
    res.json({ success: true, message: 'Đã kích hoạt giả lập cháy!', state: currentState });
  });

  // 5. Reset System Alarm
  router.post('/reset', async (req, res) => {
    currentState.fire = false;
    currentState.flame = false;
    currentState.temperature = 32.0;
    currentState.smoke = 12.0;
    currentState.gas = 5.0;
    currentState.source = currentState.esp32Connected ? 'ESP32_HARDWARE' : 'SIMULATION';

    await broadcastUpdate('reset');
    res.json({ success: true, message: 'Đã reset hệ thống an toàn!', state: currentState });
  });

  // 6. Clear Logs
  router.post('/logs/clear', async (req, res) => {
    try {
      await db.clearLogs();
      const logs = await db.getRecentLogs(10);
      io.emit('logs_cleared');
      res.json({ success: true, message: 'Đã xóa lịch sử', logs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Export tick simulation function for standalone mode when ESP32 is offline
  router.tickSimulation = async function () {
    // Only auto-tick simulation if ESP32 has not sent data in the last 10 seconds
    const now = Date.now();
    const lastPing = currentState.lastEsp32Ping ? new Date(currentState.lastEsp32Ping).getTime() : 0;
    
    if (now - lastPing > 10000) {
      currentState.esp32Connected = false;
    }

    if (!currentState.esp32Connected) {
      if (currentState.fire) {
        currentState.temperature = Math.min(88, currentState.temperature + 3.5 + Math.random() * 2);
        currentState.smoke = Math.min(98, currentState.smoke + 5 + Math.random() * 3);
        currentState.gas = Math.min(85, currentState.gas + 4 + Math.random() * 2);
      } else {
        currentState.temperature = Math.max(28, Math.min(36, currentState.temperature + (Math.random() - 0.5) * 1.2 - (currentState.temperature > 36 ? 1.5 : 0)));
        currentState.smoke = Math.max(8, Math.min(18, currentState.smoke + (Math.random() - 0.5) * 2 - (currentState.smoke > 18 ? 3 : 0)));
        currentState.gas = Math.max(3, Math.min(15, currentState.gas + (Math.random() - 0.5) * 1 - (currentState.gas > 12 ? 2 : 0)));
      }
      await broadcastUpdate('tick');
    }
  };

  return router;
};
