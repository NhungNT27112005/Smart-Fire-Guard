# Frontend dashboard upgrade

Ngày: 18/10/2026. Giữ HTML/CSS/JavaScript thuần, CommonJS backend và REST/Socket.IO contracts hiện có. Không thêm package, không sửa backend, firmware, trọng số hoặc database. Các báo cáo phân tích trước đó mô tả snapshot trước đợt nâng cấp giao diện này.

## Thiết kế và cấu trúc

- App shell: sidebar navy, header, breadcrumb, trạng thái máy chủ, tiêu đề trang và thông tin nguồn dữ liệu chung.
- Design tokens: CSS variables cho surface/text/border/accent, ba màu nhiệt độ–gas–khói và bốn trạng thái good/warning/danger/unknown; Light/Dark/System lưu localStorage.
- Components: metric card, status badge, notice, panel, SVG trend chart, device row, event list, form và toast. Không có ảnh, font hoặc chart dependency từ CDN.
- Bảy trang điều hướng bằng hash: Tổng quan, Cảm biến, Thiết bị, Camera & AI, Cảnh báo, Nhật ký, Cài đặt. Hash cũ `dash/sens/cam/hist/iot` vẫn được ánh xạ.
- Breakpoints CSS: 1200px giảm khoảng cách; 980px card 2 cột và panel 1 cột; 760px sidebar drawer và bố cục mobile; 400px giảm padding. Bảng cuộn trong panel, không ép toàn trang theo chiều rộng bảng.
- Accessibility: skip link, label cho trường nhập, focus-visible, aria-current, nút mở menu có aria-expanded, Escape/focus trap và inert cho drawer đóng trên mobile; tôn trọng prefers-reduced-motion.

`public/index.html` chứa nội dung và cấu trúc trang; `public/css/style.css` chứa tokens/layout/components/responsive; `public/js/app.js` điều phối transport, state, source/freshness, charts, forms, camera, âm thanh và renderer. Không đưa dữ liệu mẫu giả vào frontend chạy thật.

## Hành vi đã triển khai

| Module | Chức năng |
|---|---|
| Tổng quan | Nhiệt độ/gas/khói/flame, trạng thái tổng, xu hướng, thiết bị và sự kiện gần đây |
| Cảm biến | Ba biểu đồ riêng, kiểm tra finite/range, dữ liệu thiếu/không hợp lệ/cũ và giới hạn sensor health |
| Thiết bị | Một ESP32 theo API hiện có, online theo ping, lần gửi cuối, tên/vị trí lưu trên trình duyệt, endpoint/payload/pin hướng dẫn |
| Camera | Opt-in webcam, bật/tắt, dừng track/timer khi đổi trang/ẩn tab/pagehide, thông báo thiếu HTTPS/permission/thiết bị; vẫn dùng event AI cũ có nhãn DEMO |
| Cảnh báo | Phân cấp mức độ, nguồn, điều khiển giả lập/reset/còi; xác nhận các tác động chung của server trước thao tác |
| Nhật ký | API 50 event, bộ lọc mức độ, loading/empty/error/retry, giữ dữ liệu cũ kèm lỗi; bảng 120 mẫu trong phiên và CSV |
| Cài đặt | Đọc ngưỡng server, thử WARN/DANGER cục bộ với kiểm tra WARN < DANGER; chọn Light/Dark/System |

Socket là nguồn cập nhật chính; HTTP có timeout 8s và polling dự phòng 10s. Status response tới muộn không ghi đè telemetry mới. UI không thay 0 bằng giá trị mặc định, không đồng nhất AI/flame với level tổng. Dữ liệu cũ/mất kết nối không được hiển thị thành môi trường an toàn.

Biểu đồ dùng thời gian nhận mẫu thực, giữ tối đa 120 mẫu, xem 30/60/120 mẫu; không nối qua giá trị thiếu, khoảng ngắt >12s hoặc đổi nguồn live/demo. Mẫu DEMO vẽ nét đứt, có nhãn nguồn toàn trang, trong bảng và CSV. Nhật ký cũ thiếu nguồn hiển thị “Không xác định” thay vì suy đoán hardware. Nội dung log/tên thiết bị được escape hoặc render bằng textContent.

## Giới hạn còn phụ thuộc backend

1. API chưa có registry/ID riêng cho nhiều thiết bị, thêm/xóa thiết bị hay lưu tên/vị trí. Trang Thiết bị không giả vờ thực hiện những thao tác này.
2. API chưa có cập nhật ngưỡng. Ngưỡng đang áp dụng là chỉ đọc; bản đề xuất không thay đổi alarm engine hay lưu lên server.
3. Chưa có endpoint sensor history. Biểu đồ và bảng cảm biến là dữ liệu nhận trong phiên; nhật ký cảnh báo vẫn đọc SQLite qua API cũ. CSV không phải export toàn database.
4. AI ảnh hiện là random mock trong `server.js`. UI gắn DEMO cho mọi kết quả đó, không báo đây là YOLO thật; confidence nhận từ mock được mô tả là độ tin cậy giả lập. ESP32-CAM chưa tích hợp.
5. Backend tự mô phỏng khi ESP32 offline và có thể giữ source hardware cũ. UI coi `source=SIMULATION` hoặc `esp32Connected!==true` là DEMO. Đây là cách phân loại theo contract hiện tại, không phải xác minh danh tính thiết bị.
6. Backend chưa có sensor fault flags; firmware có thể che lỗi DHT bằng 30°C và suy ra gas từ smoke. UI chỉ kiểm tra dữ liệu, nêu rõ không xác nhận sức khỏe vật lý của cảm biến.
7. Reset/simulation vẫn tác động state chung trên server; giữ tính năng cũ và yêu cầu xác nhận tác động. Auth, state fusion và những lỗi backend khác trong PROJECT_ANALYSIS chưa được sửa trong đợt UI.

## Kiểm tra

```powershell
node --check public/js/app.js
node --test tests/frontend.test.cjs
```

Kết quả: cú pháp pass, **9/9 tests pass**. Tests sử dụng Node VM và DOM tối thiểu, kiểm tra:

- HTML có ID duy nhất, text tiếng Việt UTF-8 đúng và assets tồn tại.
- Loading/empty, 0 đúng, DEMO, ngưỡng đọc được và preview không hợp lệ.
- Sensor invalid và unknown; samples giới hạn 120, chart DEMO nét đứt.
- Mất kết nối và ping cũ, giữ số đo cũ nhưng không kết luận safe.
- Escape log HTML, nguồn DEMO và bộ lọc rỗng.
- HTTP 503 và phục hồi.
- Lưu tên/Light–Dark cục bộ và điều hướng cả bảy trang.
- HTTP response tới muộn không ghi đè telemetry mới.
- Camera không hỗ trợ và hủy thao tác không gửi request điều khiển.

Không có script `build` hoặc bundler trong `package.json`; frontend được Express phục vụ trực tiếp. Không thêm bước build giả. CSS được kiểm tra cân bằng braces, HTML qua parser và liên kết/ID. `git diff --check` pass.

Preview cô lập tùy chọn:

```powershell
node tests/preview-server.cjs
# Mở http://localhost:4318
# Ctrl+C để dừng
```

Preview chỉ bind 127.0.0.1, dùng route factory thật với persistence giả lập trong bộ nhớ; không mở database dự án. Dữ liệu và kết quả AI ở đây chỉ để thử DEMO, không phải test AI hoặc SQLite. Có endpoint `POST /__test/invalid` riêng để phát payload lỗi thử UI. Không đưa preview này vào production. Đã xác minh HTTP 200 cho status và assets CSS/JS; chưa dùng camera thật hay thay state của server đang vận hành.

**Giới hạn xác minh trực quan:** công cụ browser không có phiên khả dụng. Computer Use Windows đã tự dừng vì không xác định được URL Chrome đủ tin cậy để áp dụng policy; không tiếp tục thao tác UI sau đó. Vì vậy chưa có screenshot hoặc kiểm chứng layout thực tế desktop/tablet/mobile, quyền webcam, âm thanh hoặc browser E2E. Bộ test VM không thay thế các kiểm tra này.

Checklist browser còn cần thực hiện: viewport 1440/1024/768/390/360px, mọi trang ở Light/Dark, tab keyboard/drawer, text dài, offline/HTTP error, empty logs, invalid sensor payload, camera allow/deny/disconnect/stop, âm thanh với user gesture và CSV tải xuống. Không tuyên bố các mục này đã pass.
