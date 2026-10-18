# Smart Fire Guard

Dashboard IoT giám sát nhiệt độ, khói, gas và ngọn lửa với Node.js/Express, Socket.IO, SQLite, ESP32 và Python Flask/YOLO.

Đánh giá ML mới: dữ liệu hiện có chưa đủ để train/chứng minh hiệu quả thực tế. Xem [AI assessment](docs/AI_ASSESSMENT.md), [protocol train/evaluation/inference](docs/AI_TRAINING_AND_EVALUATION.md) và [audit dữ liệu](docs/AI_DATA_AUDIT.json). AI chỉ hỗ trợ quan sát, không thay thế luật cảm biến. `.env.example` chọn chế độ nạp giới hạn `restricted`; nếu runtime không hỗ trợ thì AI unavailable. Chế độ nạp thông thường `trusted` vẫn cần kiểm tra nguồn và pin hash. Xem [hướng dẫn AI runtime](docs/AI_RUNTIME_TROUBLESHOOTING.md).

Backend hiện có xác thực người dùng, phân quyền, token thiết bị riêng, validation telemetry, lịch sử/audit, trạng thái offline/stale và DEMO tách khỏi dữ liệu thật. Frontend dùng HTML/CSS/JavaScript, Light/Dark Mode và đăng nhập bằng session cookie.

## Chạy hệ thống

Yêu cầu Node.js **22.16 trở lên**. Manifest/lockfile dùng Express 5, sqlite3 6 và Socket.IO 4 đã có trong môi trường dự án. Python chỉ cần nếu bật nhận diện ảnh.

1. Sao lưu SQLite trước lần nâng cấp schema đầu tiên:

   ```powershell
   python scripts/backup-db.py data/fire_guard.db data/fire_guard.backup.db
   ```

   Chọn file đích chưa tồn tại. Script dùng SQLite backup API, mở source read-only. Migration giữ bảng/lịch sử cũ và thêm quan hệ mới; không tự gán thiết bị cho bản ghi legacy.

2. Copy `.env.example` thành `.env`; tự điền `BOOTSTRAP_ADMIN_USERNAME` và mật khẩu riêng tối thiểu 12 ký tự. Không có tài khoản/mật khẩu mặc định. Không commit `.env`. Bootstrap chỉ tạo admin khi chưa có active admin, không reset password đã lưu.

3. Cài dependencies trong môi trường mới bằng `npm ci`, sau đó:

   ```powershell
   npm start
   ```

4. Mở `http://localhost:3000`, đăng nhập. Mặc định bind 127.0.0.1. Với LAN, cấu hình HOST và APP_ORIGINS đúng scheme/IP/port. Production cần HTTPS reverse proxy và `COOKIE_SECURE=true`; không gửi credentials qua HTTP trên mạng không tin cậy.

5. Admin đăng ký thiết bị bằng `POST /api/devices`, giữ cookie/CSRF từ login. API trả `deviceToken` một lần. Copy `esp32/secrets.example.h` thành `esp32/esp32_fire_guard/secrets.h` rồi điền Wi-Fi, URL server và token. Mở sketch `esp32/esp32_fire_guard/esp32_fire_guard.ino`. Firmware gửi `Authorization: Bearer <deviceToken>`; API không nhận telemetry vô danh. Chi tiết tại [BACKEND_API.md](docs/BACKEND_API.md) và [hướng dẫn ESP32](esp32/README.md).

6. AI tùy chọn:

   ```powershell
   python -m pip install -r ai/requirements.txt
   npm run start:ai
   ```

   Python bind 127.0.0.1:5000, load `ai/best.pt` theo đường dẫn file. Nút webcam cần quyền camera/secure context và role operator/admin. Kết quả AI không còn random; hiện chưa fusion vào còi hay alert thiết bị. Model metrics chưa được kiểm chứng.

## Chức năng và giới hạn

- Registry nhiều thiết bị, bốn sensor metadata/device; token lưu hash và có rotate/disable.
- Telemetry finite/range/type validation, sensor fault null; timestamp và sequence nếu cung cấp được kiểm tra age/order/duplicate. Firmware hiện chưa gửi timestamp/sequence nên chưa chống replay hoàn chỉnh.
- Online/stale/offline có số đo cuối và lastKnownLevel; heartbeat không sinh dữ liệu cảm biến giả.
- Viewer đọc; operator acknowledge/DEMO/camera; admin quản lý user/device/threshold/xóa logs. Mutations người dùng cần CSRF.
- DEMO tắt mặc định, bật bằng `DEMO_ENABLED=true`; reset chỉ kết thúc DEMO, không sửa telemetry thật.
- API lịch sử sensor/event có phân trang. Biểu đồ frontend vẫn giới hạn 120 mẫu nhận trong phiên; tên/vị trí cá nhân là alias local, registry server hiển thị riêng.
- Một installation/một Node process/SQLite local. Chưa tenant ACL, distributed limiter/HA, retention hay local fail-safe hoàn chỉnh trên ESP32. Chưa xác minh hardware/browser E2E.

## Kiểm thử

```powershell
npm test
npm run test:integration
npm run test:ai
```

Tests Node dùng HTTP/Socket.IO thật và SQLite tạm cho backend, VM DOM cho frontend. Tests Python dùng Flask client/JPEG thật nhưng model stub; không nạp trọng số. Không mở database đang dùng, không đọc `.env` thật, không in mật khẩu/token thật.

Preview độc lập: `npm run preview`, mở localhost:4318. SQLite in-memory và DEMO explicit; tài khoản/mật khẩu dùng một lần được in trong terminal. Không dùng tài khoản/DB thật. Ctrl+C để dừng.

## Tài liệu

- [Backend architecture và ERD](docs/BACKEND_ARCHITECTURE.md)
- [API, cấu hình và báo cáo kiểm thử](docs/BACKEND_API.md)
- [Phân tích repository trước nâng cấp](docs/PROJECT_ANALYSIS.md)
- [Kiến trúc prototype trước nâng cấp](docs/ARCHITECTURE.md)
- [Kế hoạch phát triển ban đầu](docs/DEVELOPMENT_PLAN.md)
- [Frontend upgrade trước khi bổ sung auth backend](docs/FRONTEND_UPGRADE.md)

Các báo cáo snapshot cũ được giữ để tra cứu; contract hiện tại theo hai tài liệu backend phía trên.
