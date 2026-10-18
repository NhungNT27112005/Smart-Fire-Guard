# Kế hoạch nâng cấp Smart Fire Guard

Ngày: 18/10/2026. Đây là kế hoạch trước lập trình; chưa triển khai bất kỳ thay đổi ứng dụng nào. Căn cứ: [PROJECT_ANALYSIS.md](PROJECT_ANALYSIS.md), [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Mục tiêu và nguyên tắc

Mục tiêu BTL xuất sắc: một demo IoT + AI chạy end-to-end có thể tái lập, dữ liệu thật/giả rõ ràng, phát hiện lỗi mạng/cảm biến, có kiểm thử và số liệu đánh giá thực nghiệm. Không đặt mục tiêu chứng nhận hệ thống báo cháy chuyên dụng từ prototype này.

Giữ stack và các hợp đồng đang có giá trị: Node/CommonJS, Express/Socket.IO, SQLite, frontend thuần, Python Flask/YOLO và Arduino ESP32. Mỗi đợt nhỏ phải có đầu ra, cách kiểm chứng và cách quay lại baseline. Không tự ý đổi major version hoặc viết lại frontend. Các con số thời gian/hiệu năng dưới đây là **ước lượng và mục tiêu đề xuất**, không phải kết quả đã đạt.

Thứ tự: baseline tái lập → sửa tính đúng đắn/trộn nguồn → bảo vệ thao tác và payload → tích hợp AI → xác minh hardware độc lập mạng → hoàn thiện history/UI → đo đạc, báo cáo. Nhóm firmware có thể làm sớm sau khi chốt hợp đồng telemetry, nhưng không coi demo tích hợp hoàn tất trước kiểm tra thiết bị thật.

## 2. Các giai đoạn có điều kiện hoàn thành

### Giai đoạn 0 — Chốt baseline và môi trường (P1, khoảng 0,5–1 ngày)

1. Lưu diff ba file đang sửa, ghi nhận commit/môi trường, backup DB và weights kèm hash. Không ghi đè working tree của người dùng.
2. Xác định phiên bản Express/sqlite3 nào có bằng chứng chạy ổn định. Đồng bộ manifest/lock theo quyết định đó; kiểm chứng sạch trên thư mục/môi trường tách biệt, không xóa node_modules hiện tại để thử.
3. Khai báo Node runtime phù hợp `fetch`, Python requirements có version đã kiểm thử, Arduino core/libraries, cách chạy AI đúng thư mục và cấu hình mẫu không chứa secrets.
4. Bổ sung .gitignore và kế hoạch bỏ track dependencies/generated artifacts sau backup; không xóa database/trọng số để làm sạch Git.

**Đầu ra:** hướng dẫn bootstrap, config mẫu, dependency baseline nhất quán. **Nghiệm thu:** cài sạch tái lập được, `npm ls` hợp lệ, start Node và AI được trên môi trường thử; schema gốc còn nguyên. **Phụ thuộc:** không. **Quay lại:** phục hồi manifest/lock/baseline đã ghi nhận, giữ backup dữ liệu.

### Giai đoạn 1 — Sửa dữ liệu và trạng thái cảnh báo (P0, khoảng 1–2 ngày)

1. Chốt schema telemetry: bắt buộc số hữu hạn, range đã công bố, flame boolean hoặc 0/1 được quy định; reject strings/null/partial payload ngoài contract trước mutation. Payload rỗng không đánh dấu device online.
2. Tách LIVE/DEMO/OFFLINE và freshness; demo không sửa telemetry hoặc command hardware. Offline hiển thị mất liên lạc và snapshot cũ có timestamp, không tự sinh dữ liệu giả vào luồng live.
3. Tách acknowledge/silence khỏi telemetry, reset demo khỏi reset alarm; sửa latch `fire` simulation và nguồn bị giữ sai khi chuyển mode.
4. Tách tính threshold thành hàm thuần, dùng một cấu hình cho API/UI; sửa zero fallback và tách card flame/AI/overall.
5. Loại Promise khỏi state response; giữ AI unavailable/chờ ảnh rõ ràng trước khi nối inference thật. Sửa chỉ một `await` không đủ nếu vẫn truyền null.
6. Dùng snapshot và xử lý transition theo thứ tự, transaction khi cần; catch timer/async errors, readiness DB và response lỗi nhất quán.

**Liên quan:** F02–F04, F07–F09, F13. **Nghiệm thu:** test biên 45/60 và 30/60; 0 hiển thị đúng; invalid payload trả 400 và state không đổi; reset không biến 70°C thành an toàn; hardware an toàn sau demo không bị latch giả; offline không đổi source thành hardware giả; burst requests không trộn reading/event. Test DB lỗi không làm timer tạo unhandled rejection. **Quay lại:** từng commit nhỏ; không migration phá dữ liệu.

### Giai đoạn 2 — Bảo vệ API/Socket và thao tác quản trị (P0/P1, khoảng 1–2 ngày)

1. Device identity/token và operator authentication/authorization theo quy mô BTL; không cần xây hệ thống quản lý người dùng lớn khi chỉ một người vận hành.
2. Bảo vệ POST telemetry, simulation/reset/clear và `analyze_ai_frame`; origin allowlist, request/frame bounds, rate limit; không coi CORS là authentication.
3. Escape/render text log an toàn; lỗi trả client không lộ chi tiết DB; ghi audit cho thao tác quản trị, xác định retention và chính sách xóa log.
4. Config qua môi trường/cấu hình được ignore, không để khóa thật trong firmware track Git; thiết lập HTTPS cho demo camera trên LAN nếu cần.

**Liên quan:** F05, F12, F14. **Nghiệm thu:** client thiếu/sai token bị từ chối; device không có quyền xóa/reset; socket chưa xác thực không gửi inference được; payload quá lớn bị chặn có kiểm soát; chuỗi HTML trong log chỉ hiện văn bản. **Phụ thuộc:** giai đoạn 0–1 để có payload/state ổn định. **Quay lại:** config và backup credential; không hạ bảo vệ trên môi trường đã expose.

### Giai đoạn 3 — Nối AI thật vào luồng cảnh báo (P0/P1, khoảng 2–3 ngày)

1. Node nhận frame → await adapter → Flask `/detect` → kết quả có schema → AI state → alarm engine → event/UI; bỏ random khỏi đường live, giữ mock có nhãn DEMO nếu phục vụ test.
2. Resolve weights theo vị trí file/config; kiểm tra tên class thật của model, provenance/license và hash. Không giả định model mang tên/kiến trúc trong README chỉ từ tên file `.pt`.
3. Validation ảnh, HTTP status/schema, timeout, concurrency bound, frame ID/camera ID; bỏ ảnh/kết quả cũ khi quá tải, không xếp hàng vô hạn.
4. Trả confidence dạng number/null, class/box theo kích thước ảnh và latency; hold 10s theo camera và trạng thái held riêng; phân biệt fire/smoke nếu model có cả hai.
5. Chốt policy fusion: sensor danger luôn giữ danger; AI positive ổn định có thể nâng alarm; AI unavailable có trạng thái degraded, không được chứng nhận safe; ghi policy và test hysteresis.
6. Một renderer AI thống nhất; xin quyền camera có giải thích, có nút dừng gửi ảnh, không ghi ảnh mặc định. Box hiển thị từ model, bỏ box trang trí gây nhầm.

**Liên quan:** F01–F02, F11–F13. **Nghiệm thu:** ảnh fixture fire/smoke/negative đi qua HTTP thật, kết quả khớp raw inference; tắt Python hiện unavailable; reconnect phục hồi; kết quả tới trễ không ghi đè mới; camera A không giữ cảnh báo cho B; test fusion đầy đủ. Chưa dùng bộ test để tinh chỉnh threshold rồi báo lại trên cùng tập. **Phụ thuộc:** 1–2. **Quay lại:** tắt AI bằng config và hiển thị degraded; không tự đổi thành random/normal.

### Giai đoạn 4 — Kiểm chứng IoT trên thiết bị (P0/P1, khoảng 2–3 ngày, phụ thuộc có phần cứng)

1. Compile firmware với version thư viện đã chốt; chụp sơ đồ/pin thực tế, xác minh giới hạn điện áp/nguồn theo đúng module đang có trước khi đấu. Ghi rõ chưa có MQ-135 và gas đang là giá trị suy ra nếu chưa lắp cảm biến riêng.
2. Đọc cảm biến và điều khiển còi/LED non-blocking độc lập Wi-Fi/HTTP; sensor fault rõ ràng thay vì giả 30°C. Warm-up/calibration MQ2 và raw ADC được ghi nhận.
3. Validate response 2xx/schema; network timeout/backoff; alarm cục bộ vẫn hoạt động khi không có server. Chốt hành vi latch/fault và command acknowledgment.
4. Tách timer LED khỏi chu kỳ POST; mô tả đúng một LED đơn thay vì màu chưa tồn tại. Gửi device ID, timestamp/sequence và health theo contract.
5. Đo kịch bản bình thường, sensor fault, Wi-Fi mất/khôi phục, server tắt, boot không Wi-Fi và nguồn gián đoạn bằng phương án thử an toàn, có dữ liệu kiểm soát.

**Liên quan:** F06, F15–F16. **Nghiệm thu:** có firmware build log, Serial/API/DB evidence cùng thời gian; còi cục bộ đáp ứng cả khi mất mạng; UI phân biệt offline/fault; server không thể reset số đo thật để tắt nguy cơ. **Phụ thuộc:** contract giai đoạn 1; E2E cần 2–3. **Quay lại:** firmware baseline lưu sẵn, cấu hình thiết bị riêng.

### Giai đoạn 5 — Lịch sử, dashboard và khả năng vận hành (P2, khoảng 1–2 ngày)

1. Expose sensor history có giới hạn/phân trang/time range, thêm biểu đồ xu hướng trên frontend hiện có; không bắt buộc chuyển framework.
2. Event ghi nguyên nhân/nguồn/thiết bị, thời điểm và liên kết detection/command khi cần; migration additive, backup và thử trên bản sao DB. Chỉ tạo index theo query đã đo.
3. UI dùng thresholds từ API, server/device/AI status riêng, disconnect/stale indicators, error/loading/empty states; kiểm tra mobile, webcam và âm thanh cần thao tác người dùng.
4. Chỉ fetch logs khi event đổi hoặc phân trang, tránh GET toàn bộ 50 dòng ở mỗi sensor tick; retention cho sensor history, export dữ liệu phục vụ báo cáo.
5. Health/readiness, structured logs, shutdown sạch, cấu hình port rõ cho firmware, hướng dẫn backup/restore.

**Liên quan:** F17–F19, trùng lặp tài liệu. **Nghiệm thu:** lịch sử khớp SQLite; timezone hiển thị đúng; migration giữ nguyên row cũ; restore được; browser mất kết nối không còn SYSTEM ONLINE giả; lỗi thao tác hiển thị rõ. **Phụ thuộc:** 1–4. **Quay lại:** migration có backup, version schema; chỉ rollback khi bảo toàn dữ liệu mới.

### Giai đoạn 6 — Đánh giá, CI và hồ sơ bảo vệ BTL (P1/P2, khoảng 2–3 ngày)

1. Viết bộ test tập trung risk: pure threshold/fusion, invalid telemetry, reset semantics, transitions/concurrency, auth, API + SQLite tạm, inference timeout và E2E thật. Test không ghi DB đang dùng.
2. CI chạy checks/test trên version đã chốt, kiểm tra manifest/lock; audit dependencies và xử lý theo khả năng khai thác/thực tế triển khai, không tự nâng major chỉ để hết cảnh báo.
3. Dataset/model card: nguồn, quyền sử dụng, chia train/validation/test tránh trùng cảnh, class distribution và ảnh khó (ánh sáng, hơi nước, vật màu đỏ). Đánh giá precision/recall/F1 theo class, false positives/negatives, mAP nếu có ground-truth box.
4. Benchmark trên cấu hình máy demo: inference latency p50/p95, telemetry-to-dashboard, local sensor-to-buzzer, tỷ lệ lỗi và hành vi quá tải. Ghi hardware/runtime/confidence threshold rõ.
5. README khớp code, OpenAPI/event contract, Mermaid, ERD, sơ đồ mạch/BOM, test report, risk/limitations, video demo và kịch bản dự phòng có nhãn demo.

**Nghiệm thu:** người khác dựng được hệ thống theo README, thực hiện kịch bản bên dưới, thu được số liệu/log tái kiểm chứng. Không tuyên bố độ chính xác 94% hoặc 99.2% khi chưa đo. **Phụ thuộc:** các giai đoạn trên; tài liệu/test được cập nhật xuyên suốt.

## 3. Tiêu chí chất lượng đề xuất

| Khía cạnh | Mục tiêu cần đo và nghiệm thu |
|---|---|
| Tính đúng dữ liệu | 100% ca kiểm thử validation/zero/boundary/reset/mode pass; thiếu dữ liệu không hiển thị an toàn |
| Độ trễ dashboard | Mục tiêu p95 <1s từ server nhận telemetry đến UI trên LAN; báo cáo riêng chu kỳ sampling/network |
| AI | Mục tiêu p95 ≤2s/frame trên máy demo hoặc điều chỉnh sampling theo đo thực tế; không có backlog tăng vô hạn |
| Chất lượng model | Báo cáo trên test set tách riêng; chốt tiêu chí recall/false-positive sau khi biết dữ liệu và baseline, không bịa tỷ lệ |
| Bền vững | Thử chạy 60 phút, mất mạng/server/AI có chủ đích; không crash, không tăng queue vô hạn, không đổi unknown thành safe |
| IoT | Còi local không phụ thuộc HTTP; ghi độ trễ đo thực tế và kiểm tra các lỗi cảm biến |
| Tái lập | Cài sạch, version/model hash và cấu hình mẫu đầy đủ; backup/restore có bằng chứng |

Ước lượng tổng tuần tự khoảng 9–16 ngày làm việc; phụ thuộc kinh nghiệm, số thiết bị và chất lượng model sẵn có. Dành buffer riêng cho hardware/model; chưa có cơ sở cam kết lịch cố định.

## 4. Kịch bản bảo vệ và giới hạn phạm vi

1. Khởi động từ môi trường sạch, chỉ rõ model/version và trạng thái từng subsystem.
2. LIVE telemetry từ ESP32 thật đến DB/dashboard; đưa tín hiệu kiểm thử đã kiểm soát để chuyển normal → warn → danger → recovery.
3. Inference ảnh/video kiểm thử đã chuẩn bị, hiển thị class/confidence/box và event; chứng minh dữ liệu không random.
4. Rút mạng hoặc tắt server: local alarm vẫn hoạt động, dashboard stale/offline; tắt Python: AI unavailable, sensor alarm vẫn đúng.
5. Reset/acknowledge không thay dữ liệu thật; người không có quyền không điều khiển/xóa; demo mode không phát command sang hardware.
6. Truy vấn lịch sử/export và đối chiếu log đo; trình bày cả false positives/negatives và phạm vi chưa hỗ trợ.

Ưu tiên bắt buộc: giai đoạn 0–4 và bằng chứng đánh giá cốt lõi. Mở rộng tùy thời gian: đa thiết bị/khu vực, ESP32-CAM thật, thông báo email/SMS, cấu hình threshold qua UI. Chỉ triển khai những phần này sau khi luồng đơn thiết bị ổn định; không đổi công nghệ hoặc thêm hạ tầng để làm đẹp sơ đồ.

## 5. Quyết định cần chốt khi bắt đầu thực hiện

- Baseline major Express/sqlite3 dựa trên môi trường đã chứng minh ổn định; phân tích hiện tại chưa lựa chọn thay người dùng.
- Bộ linh kiện/camera đang có, khả năng truy cập ESP32 và yêu cầu một hay nhiều thiết bị.
- Nguồn/training metadata của `best.pt`, labels thật và bộ dữ liệu đánh giá được phép dùng.
- Deadline, số thành viên và rubric môn học để điều chỉnh phạm vi, không bỏ các lỗi P0 để thêm tính năng trình diễn.

Các mục này không cản việc hoàn thành phân tích hiện tại. Bước triển khai đầu tiên là giai đoạn 0; tài liệu này không tự cấp yêu cầu sửa ứng dụng trong lượt phân tích.
