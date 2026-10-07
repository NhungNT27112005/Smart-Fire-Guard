const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
const apiRoutesFactory = require('./src/routes/api');
const apiRoutes = apiRoutesFactory(io);
app.use('/api', apiRoutes);

// Socket.io Connection Event
io.on('connection', (socket) => {
  console.log(`[WebSocket] Web Dashboard client connected: ${socket.id}`);
  
  // Hứng sự kiện web gửi ảnh lên
  socket.on('analyze_ai_frame', (data) => {
      // Chỗ này gọi hàm AI của bạn (ví dụ gọi module aiDetector)
      // Tạm thời fake logic để test UI:
      const fakeAiResult = {
          hasFire: Math.random() > 0.8, // Xác suất 20% random ra cháy để test
          confidence: (Math.random() * 20 + 80).toFixed(1) // Random 80-100%
      };
      
      // Trả kết quả ngược lại cho web
      socket.emit('ai_result', fakeAiResult);
  });

  socket.on('disconnect', () => {
    console.log(`[WebSocket] Client disconnected: ${socket.id}`);
  });
});

// Periodic Simulation Tick (runs every 1.5s when ESP32 is offline)
setInterval(() => {
  if (apiRoutes.tickSimulation) {
    apiRoutes.tickSimulation();
  }
}, 1500);

// Get Local IPv4 Address for ESP32 connection reference
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

let PORT = process.env.PORT || 3000;

function startServer(portToUse) {
  server.listen(portToUse, () => {
    const localIp = getLocalIp();
    console.log(`
========================================================================
🔥 SMART FIRE GUARD - NODE.JS IOT SERVER RUNNING!
========================================================================
🌐 Web Dashboard:      http://localhost:${portToUse}
🌐 Network IP:        http://${localIp}:${portToUse}
📡 ESP32 POST URL:     http://${localIp}:${portToUse}/api/sensor-data
========================================================================
    `);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[WARN] Cổng ${PORT} đã bị chiếm dụng. Đang tự động thử chuyển sang cổng ${PORT + 1}...`);
    PORT++;
    setTimeout(() => {
      startServer(PORT);
    }, 500);
  } else {
    console.error('Lỗi khởi động Server:', err);
  }
});

startServer(PORT);


