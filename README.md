# 🔥 SMART FIRE GUARD - HỆ THỐNG BÁO CHÁY VÀ GIÁM SÁT IOT THÔNG MINH


**Smart Fire Guard** là giải pháp IoT toàn diện giám sát, phát hiện và cảnh báo cháy nổ theo thời gian thực. Hệ thống kết hợp giữa **thiết bị phần cứng vi điều khiển ESP32**, **Server trung tâm Node.js (Express & Socket.io)**, **Cơ sở dữ liệu SQLite** và **Engine AI (YOLOv8 Vision)** giúp phát hiện sớm nguy cơ hỏa hoạn, kích hoạt còi/đèn cảnh báo tức thì và truyền thông tin lên Web Dashboard.

---

## 📋 MỤC LỤC
1. [Tính Năng Nổi Bật](#-tính-năng-nổi-bật)
2. [Kiến Trúc Hệ Thống (System Architecture)](#-kiến-trúc-hệ-thống-system-architecture)
3. [Sơ Đồ Đấu Nối Phần Cứng ESP32 (Hardware Wiring)](#-sơ-đồ-đấu-nối-phần-cứng-esp32-hardware-wiring)
4. [Cấu Trúc Thư Mục Dự Án](#-cấu-trúc-thư-mục-dự-án)
5. [Ngưỡng Cảnh Báo An Toàn (Safety Thresholds)](#-ngưỡng-cảnh-báo-an-toàn-safety-thresholds)
6. [Hướng Dẫn Cài Đặt & Chạy Hệ Thống (Quick Start)](#-hướng-dẫn-cài-đặt--chạy-hệ-thống-quick-start)
7. [Hướng Dẫn Cấu Hình ESP32 (Arduino Setup)](#-hướng-dẫn-cấu-hình-esp32-arduino-setup)
8. [Tài Liệu API & WebSockets](#-tài-liệu-api--websockets)
9. [Chế Độ Giả Lập (Simulation Mode)](#-chế-độ-giả-lập-simulation-mode)

---

## 🌟 TÍNH NĂNG NỔI BẬT

- **Giám sát chỉ số môi trường Real-time**: Theo dõi liên tục Nhiệt độ (°C), Khói (%), Khí Gas (%) và Ngọn lửa (Flame) qua giao diện Web sống động.
- **Cảnh báo tức thì đa kênh (Real-time Alerting)**:
  - Còi báo động (Active Buzzer) & Đèn LED cảnh báo cấp bách tại thiết bị ESP32.
  - Thông báo hiển thị trạng thái và âm thanh còi báo động khẩn cấp trực tiếp trên trình duyệt Web qua **Socket.io**.
- **Tích hợp Nhận diện AI (AI Computer Vision Engine)**: Mô phỏng/kết nối mô hình **YOLOv8-FireGuard-v2** nhận diện ngọn lửa & khói qua Camera Feed (ESP32-CAM).
- **Phân loại Mức độ Cảnh báo Đa cấp**:
  - `OK / NORMAL` (🟢): An toàn.
  - `WARN / WARNING` (🟡): Vượt ngưỡng cảnh báo nhẹ.
  - `BAD / DANGER` (🔴): Nguy cơ hỏa hoạn khẩn cấp.
- **Lưu trữ Lịch sử Sự kiện (SQLite Database)**: Tự động ghi nhật ký mọi sự kiện vượt ngưỡng, khôi phục an toàn và lưu vết dữ liệu cảm biến định kỳ.
- **Tự động Dự phòng (Simulation Fallback)**: Khi thiết bị ESP32 offline hoặc chưa được kết nối, hệ thống tự động kích hoạt bộ giả lập dữ liệu sinh động để kiểm thử Dashboard.
- **Tự động tìm Port khả dụng (Auto Port Switch)**: Server tự động chuyển cổng (3000 ➔ 3001 ➔ ...) nếu cổng mặc định bị chiếm dụng.

---

## 📐 KIẾN TRÚC HỆ THỐNG (SYSTEM ARCHITECTURE)

```ascii
+-----------------------------------------------------------------------+
|                         KHU VỰC THIẾT BỊ (IoT HARDWARE)               |
|                                                                       |
|  [DHT11/22]   [MQ-2 Smoke/Gas]   [Flame Sensor]   [ESP32-CAM Stream]  |
|        \             |                 /                 |            |
|         +------------+----------------+                  |            |
|                      |                                   |            |
|                      v                                   |            |
|             +-----------------+                          |            |
|             |  ESP32 Board    |                          |            |
|             +--------+--------+                          |            |
|                      |                                   |            |
|             +--------+--------+                          |            |
|             | Buzzer / Red LED|                          |            |
|             +-----------------+                          |            |
+----------------------|-----------------------------------|------------+
                       |                                   |
                Wi-Fi / HTTP POST                     MJPEG Stream
                       |                                   |
                       v                                   v
+-----------------------------------------------------------------------+
|                         CENTRAL SERVER (NODE.JS)                      |
|                                                                       |
|             +----------------------------------+                      |
|             | Express REST API (/api/sensor-data)|                    |
|             +----------------+-----------------+                      |
|                              |                                        |
|             +----------------v-----------------+                      |
|             |   AI Detection (YOLOv8 Engine)   |                      |
|             +----------------+-----------------+                      |
|                              |                                        |
|             +----------------v-----------------+                      |
|             |   SQLite Database (fire_guard.db)|                      |
|             +----------------+-----------------+                      |
|                              |                                        |
|             +----------------v-----------------+                      |
|             |     Socket.io Broadcaster        |                      |
|             +----------------+-----------------+                      |
+------------------------------|----------------------------------------+
                               |
                        WebSocket Connection
                               |
                               v
+-----------------------------------------------------------------------+
|                      CLIENT / WEB DASHBOARD                           |
|                                                                       |
|   - Bảng chỉ số môi trường theo thời gian thực (Charts & Indicators)  |
|   - Khung hình Camera Giám sát AI Live Stream                         |
|   - Nhật ký lịch sử sự kiện & Nút điều khiển / Kích hoạt giả lập      |
+-----------------------------------------------------------------------+
```

---

## 🔌 SƠ ĐỒ ĐẤU NỐI PHẦN CỨNG ESP32 (HARDWARE WIRING)

### Danh sách Linh kiện:
1. Board vi điều khiển **ESP32 Dev Module**
2. Cảm biến nhiệt độ & độ ẩm **DHT11 / DHT22**
3. Cảm biến khói & khí gas **MQ-2**
4. Cảm biến phát hiện ngọn lửa **Flame Sensor Module**
5. Còi báo động **Active Buzzer (5V)**
6. Đèn LED Cảnh báo (Đỏ / Xanh) & Điện trở 220Ω

### Bảng sơ đồ chân (Pin Mapping):

| Linh kiện | Chân trên Linh kiện | Chân kết nối ESP32 | Loại Tín hiệu | Ghi chú |
| :--- | :--- | :--- | :--- | :--- |
| **DHT11 / DHT22** | DATA / OUT | **GPIO 4 (D4)** | Digital Input | Cần điện trở kéo lên 10kΩ nếu module rời |
| **Cảm biến MQ-2** | AO (Analog Out) | **GPIO 34 (A0)** | Analog Input | Đọc điện áp chuyển đổi mức khói/gas 0-100% |
| **Flame Sensor** | DO (Digital Out) | **GPIO 18 (D18)** | Digital Input | Mức LOW (0) khi phát hiện ngọn lửa |
| **Còi Buzzer** | VCC / Signal | **GPIO 23 (D23)** | Digital Output | Xuất mức HIGH (1) để kích hoạt còi |
| **Đèn LED** | Anode (+) | **GPIO 2 (D2)** | Digital Output | Đèn LED trạng thái / Nhấp nháy cảnh báo |
| **Nguồn chung** | VCC / GND | **5V (VIN) / GND** | Nguồn | Nguồn cấp cho các cảm biến |

---

## 📁 CẤU TRÚC THƯ MỤC DỰ ÁN

```text
smart-fire-guard/
├── esp32/
│   └── esp32_fire_guard.ino    # Source code C++ nạp cho ESP32 (Arduino IDE)
├── src/
│   ├── routes/
│   │   └── api.js              # Xử lý REST API endpoints & Broadcast Socket.io
│   ├── ai-detector.js          # Engine xử lý AI nhận diện nguy cơ cháy (YOLOv8)
│   └── database.js            # Cấu hình SQLite, khởi tạo bảng sensor_logs, event_logs
├── public/
│   ├── css/
│   │   └── style.css           # Giao diện CSS Dashboard hiện đại (Dark Glassmorphism)
│   ├── js/
│   │   └── app.js              # Script xử lý Socket.io client, âm thanh còi & UI DOM
│   └── index.html              # Trang chủ Web Dashboard giám sát trực tiếp
├── data/
│   └── fire_guard.db           # File CSDL SQLite (tự tạo khi server khởi chạy)
├── server.js                   # Entry point chính của Node.js Server
├── package.json                # Khai báo thông tin dự án & dependencies
└── README.md                   # Tài liệu hướng dẫn sử dụng
```

---

## ⚠️ NGƯỠNG CẢNH BÁO AN TOÀN (SAFETY THRESHOLDS)

Hệ thống đánh giá trạng thái dựa trên các ngưỡng cài đặt trong [api.js](file:///C:/Users/Admin/.gemini/antigravity-ide/scratch/smart-fire-guard/src/routes/api.js#L27-L31):

| Thông số | Trạng thái Bình thường (NORMAL) | Cảnh báo (WARN) | Nguy hiểm / Báo cháy (DANGER) |
| :--- | :--- | :--- | :--- |
| **Nhiệt độ (°C)** | `< 45°C` | `45°C - 60°C` | `> 60°C` |
| **Nồng độ Khói (%)** | `< 30%` | `30% - 60%` | `> 60%` |
| **Khí Gas (%)** | `< 30%` | `30% - 60%` | `> 60%` |
| **Ngọn lửa (Flame)** | Không phát hiện | - | Phát hiện lửa (`Flame = 1`) |

---

## 🚀 HƯỚNG DẪN CÀI ĐẶT & CHẠY HỆ THỐNG (QUICK START)

### Yêu cầu tiên quyết:
- **Node.js**: Phiên bản 16.x trở lên ([Tải về tại đây](https://nodejs.org/)).
- **Git** (không bắt buộc).

### Các bước khởi chạy Server Node.js:

1. **Di chuyển vào thư mục dự án**:
   ```bash
   cd smart-fire-guard
   ```

2. **Cài đặt các gói phụ thuộc (Dependencies)**:
   ```bash
   npm install
   ```

3. **Khởi chạy Server**:
   - Chạy chế độ chính thức:
     ```bash
     npm start
     ```
   - Hoặc chạy chế độ phát triển:
     ```bash
     npm run dev
     ```

4. **Truy cập Web Dashboard**:
   - Mở trình duyệt web và truy cập địa chỉ: [http://localhost:3000](http://localhost:3000)
   - Hoặc địa chỉ IP mạng nội bộ được in trên cửa sổ Terminal (Ví dụ: `http://192.168.1.100:3000`).

---

## 🛠️ HƯỚNG DẪN CẤU HÌNH ESP32 (ARDUINO SETUP)

1. Mở phần mềm **Arduino IDE**.
2. Cài đặt các thư viện cần thiết qua `Library Manager` (Ctrl+Shift+I):
   - `ArduinoJson` (bởi Benoit Blanchon)
   - `DHT sensor library` (bởi Adafruit)
   - `Adafruit Unified Sensor`
3. Mở file mã nguồn: [`esp32/esp32_fire_guard.ino`](file:///C:/Users/Admin/.gemini/antigravity-ide/scratch/smart-fire-guard/esp32/esp32_fire_guard.ino).
4. Thay đổi thông tin Wi-Fi và địa chỉ IP của Server Node.js:
   ```cpp
   const char* WIFI_SSID     = "TÊN_WIFI_CỦA_BẠN";
   const char* WIFI_PASSWORD = "MẬT_KHẨU_WIFI";
   const char* SERVER_URL    = "http://192.168.1.X:3000/api/sensor-data"; // Thay 192.168.1.X bằng IP máy chủ
   ```
5. Chọn Board `ESP32 Dev Module`, chọn đúng Cổng COM và nhấn **Upload**.

---

## 📡 TÀI LIỆU API & WEBSOCKETS

### 1. HTTP REST API Endpoints

#### • Gửi dữ liệu từ ESP32 lên Server
- **URL**: `/api/sensor-data`
- **Method**: `POST`
- **Header**: `Content-Type: application/json`
- **Body Request**:
  ```json
  {
    "temperature": 38.5,
    "smoke": 25.0,
    "gas": 12.0,
    "flame": 0
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "status": "ok",
    "alarmActive": false,
    "buzzerCommand": "BUZZER_OFF",
    "ledCommand": "GREEN_ON"
  }
  ```

#### • Lấy trạng thái hiện tại của hệ thống
- **URL**: `/api/status` | **Method**: `GET`

#### • Lấy nhật ký lịch sử sự kiện từ SQLite
- **URL**: `/api/logs` | **Method**: `GET`

#### • Kích hoạt giả lập báo cháy khẩn cấp
- **URL**: `/api/simulate/fire` | **Method**: `POST`

#### • Reset hệ thống về trạng thái an toàn
- **URL**: `/api/reset` | **Method**: `POST`

#### • Xóa nhật ký lịch sử sự kiện
- **URL**: `/api/logs/clear` | **Method**: `POST`

---

### 2. Sự kiện WebSockets (Socket.io)

- **`sensor_update`**: Gửi từ Server tới tất cả Dashboard client mỗi khi có dữ liệu cảm biến mới hoặc trạng thái cảnh báo thay đổi.
- **`logs_cleared`**: Nhận thông báo khi danh sách nhật ký sự kiện được xóa sạch.

---

## 🧪 CHẾ ĐỘ GIẢ LẬP (SIMULATION MODE)

Khi chưa nối thiết bị ESP32 phần cứng, hệ thống cung cấp chế độ **Giả lập thông minh**:
1. Tự động sinh dữ liệu dao động tự nhiên cho Nhiệt độ, Khói và Gas mỗi 1.5 giây.
2. Trên Web Dashboard, bấm vào nút **"🔥 Giả lập cháy"** trong tab *Alerts* để thử nghiệm kịch bản báo động:
   - Nhiệt độ tăng lên 75°C, Khói 85%, Gas 65%, Flame = True.
   - Còi âm thanh khẩn cấp trên giao diện Web cất lên.
   - AI Detection hiển thị khung nhận diện đỏ với độ tin cậy > 90%.
   - Sự kiện báo cháy được ghi trực tiếp vào Cơ sở dữ liệu SQLite.
3. Bấm **"✅ Reset hệ thống"** để đưa toàn bộ trạng thái về mức bình thường.

---

## 📄 GIẤY PHÉP (LICENSE)

Dự án phát hành theo giấy phép **ISC License**. Bạn có thể tự do phát triển, mở rộng và ứng dụng vào học tập cũng như thực tế.
