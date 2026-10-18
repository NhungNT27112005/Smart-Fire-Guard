# Backend API và hướng dẫn chuyển đổi

> Cập nhật ML: inference hiện có trust-hash guard, frame freshness và metadata/advisory contract mở rộng. Trước khi chạy model thật, làm theo [AI_TRAINING_AND_EVALUATION.md](AI_TRAINING_AND_EVALUATION.md); các kết quả test bên dưới là snapshot đợt backend trước đó.

Ngày: 18/10/2026. Base path `/api`. Thành công có `success:true`. Lỗi thống nhất:

```json
{
  "success": false,
  "error": {"code": "VALIDATION_ERROR", "message": "Request validation failed", "details": [{"field": "temperature", "message": "Expected finite number -40–125"}]},
  "requestId": "server-generated-uuid"
}
```

Client xử lý 400 validation/JSON, 401 unauthenticated, 403 role/CSRF/origin, 404 missing, 409 duplicate/order/conflict, 413 quá kích thước, 422 telemetry cũ, 429 rate limit và 500 lỗi nội bộ đã che chi tiết. Python AI service có contract lỗi riêng `success:false,error:{code,message}`.

## 1. Khởi động và bootstrap

1. Node >=22.16.0, Python có dependencies trong `ai/requirements.txt` nếu cần AI. Không cần Python để telemetry/sensor dashboard hoạt động.
2. Trước migration, backup: `python scripts/backup-db.py data/fire_guard.db data/fire_guard.backup.db`. Chọn tên đích chưa tồn tại. Không tự reset/xóa DB khi có lỗi migration.
3. Copy `.env.example` → `.env`; điền BOOTSTRAP_ADMIN_USERNAME và mật khẩu riêng tối thiểu 12 ký tự. Không có mật khẩu thật trong file ví dụ. Không commit `.env`.
4. Chạy `npm ci` trong môi trường dựng sạch khi cần cài dependencies, rồi `npm start`. Lượt triển khai này không cài lại node_modules, chỉ đồng bộ manifest với lockfile/bản đang cài; chưa chứng minh clean install qua mạng.
5. Mở origin đúng trong APP_ORIGINS, đăng nhập dashboard. Mặc định chỉ bind loopback. Với LAN, đặt HOST=0.0.0.0 và thêm đúng scheme/host/port của dashboard vào allowlist; production bắt buộc HTTPS + COOKIE_SECURE=true ở sau proxy TLS. Không bật trust proxy tùy tiện.
6. Sau khi tạo admin, bỏ bootstrap password khỏi `.env` nếu không còn dùng; startup sau sử dụng user đã lưu. Không in mật khẩu hoặc token trong log.
7. AI tùy chọn: `npm run start:ai` từ root để truyền `.env` sang Python; model resolve theo vị trí file. Chế độ `restricted` cần runtime hỗ trợ weights-only, không tự fallback nạp pickle thông thường; xem [AI runtime](AI_RUNTIME_TROUBLESHOOTING.md). Flask chỉ bind 127.0.0.1:5000. Production cần WSGI server phù hợp, không expose inference port ra ngoài.

Node đọc `.env` bằng `process.loadEnvFile`. Cấu hình sai/thiếu admin/port bận làm startup thất bại có thông báo, không tự đổi port khiến ESP32 mất endpoint.

## 2. Auth và quyền

| Route | Quyền | Body / kết quả |
|---|---|---|
| `GET /health` | Public | Readiness kiểm tra SQLite, không lộ config |
| `POST /auth/login` | Public, rate limit | `{username,password}` → cookie + `{user,csrfToken}` |
| `GET /auth/me` | Session | User hiện tại + CSRF token |
| `POST /auth/logout` | Session + CSRF | Thu hồi session và socket của session |
| `GET /users` | Admin | Không có password hashes |
| `POST /users` | Admin + CSRF | `{username,password,role}`; username 3–64 ký tự ASCII cho phép, password 12–128 |
| `PATCH /users/:id` | Admin + CSRF | `{role?,active?,password?}`; thu hồi sessions, bảo vệ admin cuối |
| `GET /audit-logs?limit=50&offset=0` | Admin | Audit thao tác quản trị |

Mọi route người dùng trừ login/health đều cần cookie. Mutation cần `X-CSRF-Token` từ login/me. API client cần giữ cookie jar, không đưa token vào query string. Viewer được đọc; operator thêm acknowledge/DEMO/AI; admin thêm quản trị. Frontend tự xử lý cookie cùng origin và CSRF trong memory.

## 3. Thiết bị và nhận telemetry

| Route | Quyền | Hành vi |
|---|---|---|
| `GET /devices` | Viewer trở lên | Toàn registry, connection và snapshot; không có token/hash |
| `POST /devices` | Admin | `{name,location?}` → 201 `{device,deviceToken}`; token chỉ trả một lần |
| `PATCH /devices/:id` | Admin | `{name?,location?,enabled?}`; disable chặn ingest |
| `POST /devices/:id/rotate-token` | Admin | Token mới, token cũ hết hiệu lực cho request tiếp theo |
| `GET /devices/:id/sensors` | Viewer trở lên | Metadata bốn cảm biến; gas có đơn vị relative_percent |
| `POST /sensor-data` | Device Bearer token | Không nhận session thay device credentials |

Ví dụ body hợp lệ (timestamp/sequence là tùy chọn; ví dụ minh họa, không gửi timestamp cố định trong thực tế):

```json
{
  "temperature": 32.5,
  "smoke": 10,
  "gas": 8,
  "flame": 0,
  "sequence": 1,
  "measuredAt": "2026-10-18T08:00:00.000Z"
}
```

Header: `Content-Type: application/json`, `Authorization: Bearer <deviceToken>`. Token xác định device, không cần thêm deviceId. Firmware cũ phải cập nhật header; không có chế độ bypass auth ngầm.

Nếu DHT lỗi: gửi `temperature:null` và `health:{temperature:"fault"}`, còn đủ smoke/gas/flame. Health chấp nhận bốn key temperature/smoke/gas/flame, giá trị ok/fault. Số ngoài miền, chuỗi số, thiếu field, unknown field hoặc `"false"` đều bị từ chối trước khi cập nhật ping/state.

Response giữ command fields cũ và thêm readingId/sensorHealth. `status` ok/warn/bad/unknown, `alarmActive` false/true/null. Với unknown, firmware phải giữ output, không lấy null thành false. Firmware mới kiểm tra 2xx và kiểu boolean, gửi DHT fault rõ ràng; secrets mẫu tại `esp32/secrets.example.h`, copy thành `secrets.h` rồi điền riêng. Sequence nếu dùng phải lưu bền qua reboot; firmware hiện chưa gửi sequence/timestamp, nên backend chưa chống replay hoàn chỉnh với firmware này.

## 4. Status, history, alerts và ngưỡng

| Route | Quyền | Hành vi |
|---|---|---|
| `GET /status?deviceId=...` | Viewer trở lên | `{state,devices,thresholds,freshness,capabilities}`; thiếu deviceId chọn mức nghiêm trọng nhất hoặc DEMO đang chọn |
| `GET /logs` | Viewer trở lên | Event history cũ/mới, code/source/device/reading/ack khi có |
| `GET /sensor-history` | Viewer trở lên | Sensor rows từ SQLite, gồm dữ liệu cũ chưa device ID |
| `POST /alerts/:id/acknowledge` | Operator/Admin | Ghi người/thời điểm acknowledge; không sửa số đo |
| `POST /logs/clear` | Admin | Giữ chức năng cũ: xóa event rồi thêm INFO, atomic + audit; sensor rows không xóa |
| `GET /thresholds` | Viewer trở lên | Ngưỡng đang áp dụng |
| `PUT /thresholds` | Admin | Lưu JSON temp/smoke/gas mỗi cặp warn/danger; đánh giá lại device levels và ghi event/audit |
| `POST /simulate/fire` | Operator/Admin | Chỉ khi DEMO_ENABLED=true; state DEMO riêng, không ghi sensor rows hardware |
| `POST /reset` | Operator/Admin | Chỉ kết thúc DEMO đang hoạt động; không có DEMO trả 409 |

History hỗ trợ `limit` 1..200, `offset` 0..1.000.000 và `deviceId` tùy chọn, trả `pagination:{limit,offset,total}`. Mặc định 50. Các field mở rộng nullable trên dữ liệu legacy; không diễn giải null là dữ liệu thật.

Ngưỡng mặc định temp 45/60, smoke/gas 30/60, dấu `>` được giữ. Body PUT:

```json
{"temp":{"warn":45,"danger":60},"smoke":{"warn":30,"danger":60},"gas":{"warn":30,"danger":60}}
```

Threshold persists trong SQLite; UI admin có nút lưu. Tên/vị trí cá nhân cũ trên frontend vẫn là alias local; registry là dữ liệu server riêng. UI giữ giới hạn 120 mẫu nhận trong phiên, còn toàn history SQLite có API phân trang; chưa đưa full history vào biểu đồ UI.

## 5. Realtime và AI

Socket cùng origin dùng session cookie. Không nhận device token như quyền xem toàn dashboard. Session không hợp lệ bị từ chối ngay Engine.IO handshake. `sensor_update` giữ `{state,reason}` và thêm devices/thresholds/freshness/capabilities/deviceId; heartbeat không tạo sensor sample giả. `logs_cleared`, `alerts_changed` dùng để reload history. Logout/disable/expiry thu hồi truy cập socket.

`analyze_ai_frame` yêu cầu operator/admin, `{image:"data:image/jpeg;base64,..."}`, tối đa 450k ký tự, ≥2s mỗi frame, một frame đang chờ/socket. Node gọi Flask `/detect` có timeout, kiểm tra status/schema; response `ai_result` chứa `{available,hasFire,confidence,held,demo:false,statusText}`. Mất AI: available=false, hasFire=null, không báo safe. `ai_error` chứa code/message cho lỗi quyền/input/rate. Hold 10s theo socket; disconnect giải phóng, shutdown hủy pending request.

Python validate MIME/base64/JPEG/dimensions, body 512KiB, khóa inference; conf=0.15 được giữ. `fire`/`smoke` gộp thành hasFire. Model path không phụ thuộc cwd. **Chưa lưu detection hoặc điều khiển alarm từ AI**, chưa đo chất lượng model; không tuyên bố confidence là accuracy hệ thống.

## 6. Kiểm thử và kết quả

```powershell
npm test
npm run test:integration
npm run test:ai
```

Node test runner dùng `--test-isolation=none` để không cần spawn child process trong sandbox; mỗi fixture vẫn có app instance và database file tạm riêng. Tests không đọc `.env` thật, không mở DB dự án, mật khẩu/token được sinh ngẫu nhiên trong bộ nhớ và không in ra output.

Đã chạy `npm test`: **21/21 pass**, gồm 12 test backend/config/migration và 9 test frontend. Backend kiểm tra auth/roles/CSRF/cookie, token/range/order/stale, HTTP/Socket.IO thật, mất kết nối/fault/ack, DEMO/reset, threshold, concurrency/rollback, error contracts/rate limit, migration/restart/session persistence, log clearing/audit và Socket AI role. Đây là số test cases, không phải tổng số assertions.

Đã chạy `npm run test:ai`: **4/4 pass**, Flask test client + JPEG thật nhưng **model stub**. Chưa nạp trọng số YOLO, chưa compile firmware, chưa kiểm tra ESP32/camera vật lý, load test dài hạn hoặc browser E2E. `npm ls --depth=0` không còn mismatch dependency. Manifest/lock đã đồng bộ; chưa chạy clean network install.

Preview tùy chọn: `npm run preview`, dùng SQLite `:memory:`, DEMO explicit và tài khoản/mật khẩu tạm được in riêng cho một lần chạy trên loopback 4318. Không dùng tài khoản/DB thật; dừng preview sẽ mất dữ liệu. Đây không phải chế độ bypass auth của server chính.
