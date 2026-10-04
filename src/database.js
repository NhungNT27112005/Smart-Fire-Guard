const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'fire_guard.db');
const db = new sqlite3.Database(dbPath);

// Initialize Tables
db.serialize(() => {
  // Sensor readings history table
  db.run(`
    CREATE TABLE IF NOT EXISTS sensor_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      temperature REAL,
      smoke REAL,
      gas REAL,
      flame INTEGER,
      status TEXT,
      source TEXT
    )
  `);

  // Event history log table (INFO, WARN, DANGER)
  db.run(`
    CREATE TABLE IF NOT EXISTS event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      level TEXT,
      message TEXT
    )
  `);

  // Insert initial system start log if table empty
  db.get("SELECT COUNT(*) as count FROM event_logs", (err, row) => {
    if (!err && row.count === 0) {
      db.run("INSERT INTO event_logs (level, message) VALUES ('INFO', 'Hệ thống Smart Fire Guard Node.js khởi động')");
    }
  });
});

module.exports = {
  // Save sensor reading
  saveSensorReading: (data) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO sensor_logs (temperature, smoke, gas, flame, status, source)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        [
          data.temperature || 0,
          data.smoke || 0,
          data.gas || 0,
          data.flame ? 1 : 0,
          data.status || 'NORMAL',
          data.source || 'ESP32'
        ],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
      stmt.finalize();
    });
  },

  // Save event log
  saveEventLog: (level, message) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare("INSERT INTO event_logs (level, message) VALUES (?, ?)");
      stmt.run([level, message], function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
      stmt.finalize();
    });
  },

  // Get recent event logs
  getRecentLogs: (limit = 50) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT id, strftime('%Y-%m-%d %H:%M:%S', timestamp, 'localtime') as formatted_time, level, message FROM event_logs ORDER BY id DESC LIMIT ?",
        [limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  },

  // Get recent sensor history for charts
  getSensorHistory: (limit = 30) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT id, strftime('%H:%M:%S', timestamp, 'localtime') as time_str, temperature, smoke, gas, flame, status FROM sensor_logs ORDER BY id DESC LIMIT ?",
        [limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve((rows || []).reverse());
        }
      );
    });
  },

  // Clear log history
  clearLogs: () => {
    return new Promise((resolve, reject) => {
      db.run("DELETE FROM event_logs", (err) => {
        if (err) reject(err);
        else {
          db.run("INSERT INTO event_logs (level, message) VALUES ('INFO', 'Lịch sử cảnh báo đã được làm sạch')", (err2) => {
            if (err2) reject(err2);
            else resolve(true);
          });
        }
      });
    });
  }
};
