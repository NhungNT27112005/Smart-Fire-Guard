# Phân tích repository Smart Fire Guard

Ngày đánh giá: 18/10/2026 (Asia/Saigon). Phạm vi: working tree hiện tại, bao gồm thay đổi chưa commit; đây là báo cáo phân tích, không phải chứng nhận hệ thống đã chạy end-to-end.

## 1. Phạm vi và độ tin cậy

Đã đọc toàn bộ 12 file văn bản thuộc dự án: `README.md`, `package.json`, `package-lock.json`, `server.js`, ba file trong `src/`, ba file trong `public/`, firmware và Python service. Đã kiểm kê cả file ẩn, danh sách Git và dependencies. Không thấy `AGENTS.md` tại repository hoặc thư mục cha trực tiếp, không thấy cấu hình dự án trong `.agents`/`.codex`.

Hai file nhị phân được xử lý riêng: SQLite được mở bằng `OPEN_READONLY` để kiểm tra schema, số lượng, nguồn dữ liệu và integrity; `best.pt` chỉ được kiểm tra kích thước/hash, chưa nạp trọng số hay xác nhận kiến trúc/classes/độ chính xác. Không đọc từng dòng mã bên thứ ba trong `node_modules` hoặc lịch sử/objects nội bộ Git; đã kiểm kê dependency và metadata lockfile. Không coi mã bên thứ ba là mã nghiệp vụ của dự án.

Quy ước bằng chứng:

- **[M]**: xác nhận bằng đọc mã nguồn/cấu hình hiện tại.
- **[K]**: có kiểm tra thực thi được mô tả bên dưới, với giới hạn cụ thể.
- **[G]**: giả định, suy luận tác động hoặc đề xuất; chưa xác nhận trên hệ thống thật.

Trước đánh giá đã có ba file thay đổi: `ai/ai_service.py`, `src/ai-detector.js`, `data/fire_guard.db`. Đã giữ nguyên các thay đổi này. Không chạy server gốc vì vòng simulation tự ghi vào database. Không cài/cập nhật dependencies, sửa code hoặc gọi API vào hệ thống đang vận hành.

## 2. Cấu trúc và công nghệ

```text
smart-fire-guard/
├── server.js                  # Express + HTTP + Socket.IO, scheduler
├── package.json               # npm start/dev cùng chạy node server.js
├── package-lock.json          # lockfile v3, 145 package entries kể cả root
├── src/
│   ├── routes/api.js          # 6 REST routes, state và simulation
│   ├── database.js            # SQLite schema và persistence helpers
│   └── ai-detector.js         # HTTP client tới Python, giữ cảnh báo 10s
├── public/
│   ├── index.html             # 6 tab + inline webcam script
│   ├── js/app.js              # REST, Socket.IO, DOM, Web Audio
│   └── css/style.css          # responsive, light/dark theo CSS
├── ai/
│   ├── ai_service.py          # Flask + Ultralytics YOLO
│   └── best.pt                # trọng số, 24.483.111 bytes
├── esp32/esp32_fire_guard.ino # Arduino C++, Wi-Fi HTTP polling
├── data/fire_guard.db         # SQLite có dữ liệu sẵn
├── node_modules/              # dependencies hiện được Git track
└── README.md                  # hướng dẫn, có một số mô tả lệch code
```

| Thành phần | Hiện trạng đã kiểm chứng |
|---|---|
| Frontend | [M] HTML/CSS/JavaScript thuần, không React/Vue, không bundler; Socket.IO client được server cung cấp; Web Audio API; webcam qua `getUserMedia` |
| Backend | [M] Node.js CommonJS, Express, `http`, CORS, Socket.IO; một process và một state chung |
| Database | [M/K] SQLite qua `sqlite3`, file local; hai bảng nghiệp vụ, không ORM/migrations |
| AI | [M] Flask, OpenCV, NumPy, Ultralytics; `/detect` giải mã JPEG base64 và gọi model với `conf=0.15`; gộp class `fire`/`smoke` thành `hasFire` |
| IoT | [M] ESP32, Arduino WiFi/HTTPClient/ArduinoJson/DHT; GPIO DHT=4, MQ2=34, flame=18, buzzer=23, LED=2 |
| Triển khai | [M] chạy thủ công local/LAN; không có Docker, CI, health endpoint hay bộ test dự án |

**Lệch phiên bản [K]:**

| Package | `package.json` | Lockfile root / bản đang cài |
|---|---|---|
| cors | `^2.8.5` | `^2.8.6` / `2.8.6` |
| express | `^4.21.2` | `^5.2.1` / `5.2.1` |
| socket.io | `^4.8.1` | `^4.8.4` / `4.8.4` |
| sqlite3 | `^5.1.7` | `^6.0.1` / `6.0.1` |

`npm ls --depth=0` báo `ELSPROBLEMS` cho Express và sqlite3; cors/Socket.IO còn thỏa range manifest nhưng root lock vẫn lệch. Chưa chạy `npm ci`: theo [npm docs](https://docs.npmjs.com/cli/v11/commands/npm-ci/), manifest và lockfile phải đồng bộ. Chưa quyết định nâng/hạ major; cần xác lập baseline đã chạy ổn định trước.

Môi trường kiểm tra: Node `v24.14.0`, Python `3.13.5`; tìm thấy module Flask/cv2/NumPy/Ultralytics bằng `find_spec`, chưa kiểm tra import toàn bộ hay tương thích runtime. README yêu cầu Node 16+ trong khi AI client dùng global `fetch`; yêu cầu runtime chưa được khai báo bằng `engines` và chưa chứng minh chạy trên Node 16.

## 3. API và persistence thực tế

| Endpoint/event | Hành vi [M], trừ nơi ghi [K] |
|---|---|
| `POST /api/sensor-data` | Ép kiểu từng field, cập nhật state chung, ghi event khi đổi level, ghi sensor mỗi lần, phát `sensor_update`, trả `alarmActive` và command strings |
| `GET /api/status` | State trong RAM + thresholds; không đọc lại state cuối từ SQLite |
| `GET /api/logs` | 50 event mới nhất, không phân trang/lọc |
| `POST /api/simulate/fire` | Gán fire=true, 75°C, smoke=85, gas=65, flame=true; ghi/broadcast |
| `POST /api/reset` | Gán số liệu 32/12/5 và flame/fire=false; ghi/broadcast |
| `POST /api/logs/clear` | Xóa event rồi thêm một INFO; không xóa sensor history |
| `sensor_update`, `logs_cleared` | Server phát cho toàn bộ dashboard, không chia device/room |
| `analyze_ai_frame` → `ai_result` | Ảnh từ browser đến Node; Node bỏ qua nội dung và trả kết quả random cho chính socket gửi |
| Python `POST /detect` | Có mã inference thật, nhưng đường webcam hiện tại không gọi endpoint này |

Ngưỡng thực tế dùng dấu `>`: nhiệt độ ≤45 là `ok`, >45 đến 60 là `warn`, >60 là `bad`; smoke/gas tương tự tại 30 và 60. Flame hoặc cờ simulation `fire` làm level=`bad`. `aiResult` không được dùng trong `calculateLevel`.

Schema [M/K]:

- `sensor_logs(id PK AUTOINCREMENT, timestamp DEFAULT CURRENT_TIMESTAMP, temperature REAL, smoke REAL, gas REAL, flame INTEGER, status TEXT, source TEXT)`.
- `event_logs(id PK AUTOINCREMENT, timestamp DEFAULT CURRENT_TIMESTAMP, level TEXT, message TEXT)`.
- Chưa có FK, CHECK/NOT NULL cho dữ liệu nghiệp vụ, device ID, camera ID, detection record, command acknowledgment hay migration version. Chỉ thấy hai bảng nghiệp vụ và `sqlite_sequence`.
- SQL insert/query dùng placeholders; không thấy đường SQL injection trực tiếp từ các route hiện có. Không đồng nghĩa toàn hệ thống đã an toàn.
- `getSensorHistory()` tồn tại nhưng không có REST route/frontend dùng. Thời gian lưu mặc định UTC của SQLite; API format theo timezone máy chủ bằng `localtime`, không cố định Asia/Saigon.

Snapshot database [K]: integrity=`ok`, 10.302 sensor rows (10.271 NORMAL, 31 DANGER), tất cả source=`SIMULATION`; 9 event rows. Sensor timestamp từ `2026-10-03 10:34:59` đến `2026-10-17 08:24:54`; event từ `2026-10-03 10:43:11` đến `2026-10-06 16:39:55` (giá trị thô trong DB). Dữ liệu chứng minh có lưu lịch sử simulation, **không chứng minh ESP32 chưa từng chạy ở môi trường khác**.

## 4. Chức năng thật và phần giao diện/mô phỏng

| Chức năng | Mức hoàn thiện và giới hạn bằng chứng |
|---|---|
| Nhận số liệu, tính threshold, trả command | [K] Route handlers chạy được trong VM với DB/Socket giả lập; chưa HTTP/network hoặc phần cứng end-to-end |
| Simulation tick, simulate/reset | [K] Có thay đổi state, gọi persistence/broadcast trong bộ chạy cô lập; reset và trộn nguồn có lỗi quan trọng |
| SQLite event/sensor | [K] File có dữ liệu và integrity tốt; [M] đầy đủ helper ghi/đọc; chưa thực thi ghi trên DB gốc |
| Dashboard live, tab, history, progress | [M] DOM/event wiring có; [K] chạy riêng `updateUI` với DOM tối thiểu; chưa QA trình duyệt, reconnect hoặc layout thực tế |
| Còi trình duyệt | [M] Có oscillator và toggle; phụ thuộc audio permission/user gesture, chưa nghe thử; bật lại toggle khi đang alarm chưa chủ động start cho tới update kế tiếp |
| Webcam dashboard | [M] Có lấy camera local và gửi JPEG mỗi 2s; chưa cấp quyền/test camera; không phải ESP32-CAM stream |
| AI từ ảnh webcam | [M] **Đang là random mock**, không phải inference; không kích hoạt state/còi/log/ESP32 |
| Python YOLO | [M] Có inference implementation và trọng số; chưa chạy model, chưa xác nhận classes, chất lượng hay tốc độ |
| AI card và flame card | [M] Cùng lấy biến tổng hợp `fire` từ sensor/level, không phản ánh nguồn độc lập |
| Tab Camera / bounding box | [M] Placeholder, không video/img stream thật; box CSS cố định, không tọa độ YOLO |
| ESP32-CAM/MJPEG | [M] Chỉ hướng dẫn và `cameraUrl` rỗng; không firmware camera hay tích hợp stream |
| ESP32 cảm biến/còi/LED | [M] Có firmware, thông tin Wi-Fi placeholder; chưa compile/nạp/chạy hardware |
| Gas độc lập / độ ẩm | [M] Không có MQ-135 trong firmware dù UI ghi MQ-135; gas=`smoke * 0.8`; không đọc độ ẩm |
| Biểu đồ lịch sử | [M] Chưa có chart theo thời gian/API sensor history; thanh progress không phải biểu đồ lịch sử |
| Cloud, đa thiết bị, thông báo từ xa | [M] Chưa có triển khai cloud, registry/auth/device identity, email/SMS/push |

## 5. Lỗi, thiếu bảo mật và phần chưa hoàn thiện

P0 = cần xử lý trước khi dùng kết quả để kết luận trạng thái; P1 = cần trước demo tích hợp; P2 = nâng chất lượng/bảo trì. Tác động ngoài kiểm tra cô lập được ghi [G].

| ID / ưu tiên | Bằng chứng và vấn đề | Hướng xử lý đề xuất [G] |
|---|---|---|
| F01 / P0 | [M] `server.js:33-42` trả random 20% có cháy, confidence 80–100, bỏ qua ảnh; kết quả không vào alarm | Nối adapter AI thật; mock chỉ khi chọn demo rõ ràng; thống nhất luồng detection → state |
| F02 / P0 | [M/K] `api.js:60-66` gán Promise từ async `analyzeFrame(null, ...)`, không await; JSON nhận `aiResult={}`. Truyền null luôn đi nhánh chờ ảnh; tham số sensors thứ hai không được adapter dùng | Await khi có ảnh hợp lệ; sensor update không ghi đè kết quả AI gần nhất; không chỉ thêm await rồi coi đã xong |
| F03 / P0 | [M/K] `api.js:163-172` reset gán số đo bình thường, vẫn ghi nguồn hardware khi đang online; kiểm tra 70°C → reset cho `ok` | Tách acknowledge/silence/reset simulation; không thay đổi telemetry thật để xóa cảnh báo |
| F04 / P0 | [M/K] `api.js:103-108` không validate: `"false"` thành true, `"abc"` thành NaN → JSON null nhưng route vẫn success/ok; `{}` cũng được tính là ping hardware | Schema strict, finite/range/required; validate toàn payload trước mutation; lỗi 400 và không thay state |
| F05 / P0 | [M] `server.js:10-20`, toàn bộ routes: không auth/authorization, CORS rộng; bất kỳ client tiếp cận mạng có thể post số liệu, simulate/reset/xóa event | Xác thực device và operator riêng; phân quyền thao tác, hạn chế origin, rate limit, giới hạn payload |
| F06 / P0 | [M] `esp32...ino:61-65,74-134`: chưa Wi-Fi thì setup chờ vô hạn; mất Wi-Fi không đọc sensor; còi chỉ theo HTTP response, không có luật alarm cục bộ | Đọc/cảnh báo tại thiết bị độc lập server; mạng chạy non-blocking; kiểm tra mất mạng thật |
| F07 / P1 | [M/K] Simulation đặt `fire=true`; POST hardware an toàn không xóa cờ nên vẫn bad. Tick timeout có thể giữ `source=ESP32_HARDWARE` từ lần trước, thay số thật bằng số giả nhưng giữ flame cũ | Tách LIVE/DEMO/OFFLINE, snapshot theo nguồn; mất thiết bị phải unknown/stale; giữ demo riêng |
| F08 / P1 | [M/K] `app.js:101-103` dùng `||` làm 0°C/0% thành 32/12/5; `level=bad` làm flame và AI card đều FIRE | Fallback bằng nullish và validation; render từng evidence riêng |
| F09 / P1 | [M] `api.js:48-97` chia sẻ mutable state qua await; timer `server.js:51-55` không await/catch; simulate/reset thiếu catch | [G] Request xen kẽ có thể trộn event/reading/response, nhân event hoặc unhandled rejection khi DB lỗi; cần snapshot, serialization/transaction và xử lý lỗi |
| F10 / P1 | [M/K] Manifest/lock/install lệch major; chưa có Python requirements hay pin Arduino libs | Chọn baseline có kiểm chứng, đồng bộ version, hướng dẫn tái lập; không tự nâng/hạ major |
| F11 / P1 | [M] `ai_service.py:10` load `best.pt` theo working directory; chạy `python ai/ai_service.py` từ root không trỏ `ai/best.pt` | Resolve theo file; config địa chỉ/timeout; health báo model readiness |
| F12 / P1 | [M] AI client không timeout/kiểm tra HTTP status/schema; Flask không validate base64, ảnh rỗng, decoded image hoặc kích thước; lỗi kết nối trả `hasFire=false` | Tách unavailable khỏi negative; bounded request/frame size và inference concurrency; response contract rõ |
| F13 / P1 | [M] `app.js` và inline script cùng ghi `det`; `aiResult={}` khiến `statusText` undefined, tick ghi đè thông tin webcam; hold AI là global và confidence có lúc string | Một renderer; camera-scoped hold state; confidence number/null, hold flag riêng |
| F14 / P1 | [M] `app.js` history render `r.message` bằng innerHTML không escape | Đây là HTML injection sink; [G] chưa xác nhận stored-XSS qua API hiện tại vì message do server tạo và số được parse; dùng textContent/DOM an toàn |
| F15 / P1 | [M] Firmware nhận mọi HTTP status >0, đọc `alarmActive` default false; LED chỉ cập nhật một lần mỗi loop có delay 1.5s, không blink đều 250ms; command strings màu không được xử lý, chỉ một GPIO LED | Chỉ nhận response 2xx + schema hợp lệ; state command/ack, timer LED riêng; mô tả đúng một LED |
| F16 / P1 | [M] DHT NaN thay bằng 30°C; MQ2 map ADC thành % tuyến tính, gas suy ra smoke | Gửi sensor health/raw ADC; công bố giá trị tương đối, chưa gọi là nồng độ đã hiệu chuẩn; kiểm tra wiring/nguồn bằng phần cứng thực tế |
| F17 / P2 | [M] `getSensorHistory` chưa dùng, sensor table tăng vô hạn; event clear hai statement không transaction; init DB không có readiness/error handling đầy đủ | Bổ sung API lịch sử có bound, retention, migration và backup; readiness/transactions |
| F18 / P2 | [M] 2.115 file Git track, 2.101 thuộc node_modules; DB và weights cùng track, không .gitignore | Sau sao lưu mới bỏ track generated files; quản lý model provenance/hash/license, dữ liệu demo tách biệt |
| F19 / P2 | [M] Không listener disconnect/connect_error để hạ trạng thái SYSTEM ONLINE; fetch thao tác không check res.ok; audio resume chưa xử lý rejection | Hiển thị server/device/AI độc lập; lỗi thao tác rõ ràng, chỉ báo dữ liệu cũ |

Express đang cài là 5 nhưng manifest khai báo 4: không kết luận mọi async route hiện chắc chắn bị treo. Cơ chế tự chuyển rejected Promise của Express 5 được mô tả trong [Express error handling](https://expressjs.com/en/guide/error-handling/); nếu chọn baseline Express 4 cần xử lý async tương thích. Timer không thuộc route vẫn cần catch riêng.

Camera trên HTTP LAN có thể không dùng được vì `getUserMedia` cần secure context, ngoại lệ điển hình là localhost; code gọi `navigator.mediaDevices.getUserMedia` trực tiếp nên trường hợp `mediaDevices` undefined có thể throw trước `.catch`. Đây là giới hạn trình duyệt theo [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), chưa thử browser thực tế.

Không thực hiện audit CVE trực tuyến cho dependency tree; không gán CVE hoặc kết luận package có lỗ hổng chỉ từ số phiên bản. Wi-Fi credentials hiện là placeholder, chưa thấy bí mật thật trong mã dự án đã đọc.

## 6. Trùng lặp và khả năng bảo trì

- Threshold và quy tắc level lặp ở backend, frontend, bảng HTML và README; README ghi biên 45/30 khác code dùng `>`. Cần một nguồn cấu hình và test biên.
- Cập nhật trạng thái AI lặp giữa `updateUI` và inline script; các card AI/flame dùng cùng biến dù ý nghĩa khác nhau.
- Giá trị reset 32/12/5 lặp ở state và frontend fallback; giá trị mặc định đang che lỗi dữ liệu.
- Hướng dẫn/sơ đồ ASCII lặp giữa README và tab IoT, mô tả cloud/camera chưa có; có link `file:///C:/...` phụ thuộc máy tác giả.
- Module router được tạo ở top-level, state cũng top-level: factory không tạo state độc lập; khó kiểm thử nhiều instance. Route đang kiêm validate, điều phối state, simulation, event và persistence.
- Không cần rewrite framework để giải quyết: tách các hàm nhỏ thuần và service điều phối trong CommonJS hiện có.

## 7. Kiểm tra đã thực hiện và giới hạn

| Kiểm tra | Kết quả |
|---|---|
| Inventory `rg --files --hidden`, Git status/tracked | Đọc đủ file dự án; xác định ba sửa đổi có sẵn và dependencies bị track |
| Parse toàn bộ lockfile, npm ls | 145 entries; mismatch Express/sqlite3 được xác nhận |
| JS parse bằng `vm.Script`, cả inline script | Pass; không chứng minh đúng logic/runtime |
| Python `ast.parse`, `find_spec` | Pass cú pháp; tìm thấy module; chưa import/nạp model |
| SQLite OPEN_READONLY + integrity/schema/count/group | Integrity ok và snapshot như mục 3; không ghi dữ liệu |
| VM route handlers, fake DB và Socket | Xác nhận mức 45/45.1/60/60.1, Promise `{}`, false-string, NaN, fire latch, reset dữ liệu hardware, simulation gọi save/broadcast |
| `updateUI` với DOM tối thiểu trong VM | Xác nhận 0 bị thay bằng 32/12/5; không phải browser E2E |

Bộ chạy kiểm chứng được đưa qua stdin, không thêm test/code vào repository. Một thử nghiệm gọi Git qua child process Node bị EPERM; đã dùng Git trực tiếp từ PowerShell và parse JS trong VM để hoàn thành kiểm kê/kiểm tra mà không cần escalation. Cảnh báo ghi npm cache log ngoài workspace không làm mất kết quả `npm ls`.

Chưa kiểm tra: HTTP/Socket.IO thật, server khởi động/auto-port, browser webcam/audio/layout, model inference/metrics, firmware compile, mạch ESP32 và hành vi mất nguồn/mất mạng. Không suy từ cú pháp pass sang hệ thống đã chạy tốt. Xem [kiến trúc](ARCHITECTURE.md) và [kế hoạch phát triển](DEVELOPMENT_PLAN.md) cho cách khép các khoảng trống này.
