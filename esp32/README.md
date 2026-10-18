# Kit ESP32 38 chân / CP2102

Firmware dành cho ESP32 DevKit dùng ESP32-WROOM-32 thông thường. CP2102 là USB–UART. Chọn **ESP32 Dev Module** trong Arduino IDE. Chưa kiểm chứng trên ESP32-CAM/C3/S3 hoặc mạch vật lý.

## Cấu hình và nạp

1. Mở `esp32_fire_guard/esp32_fire_guard.ino`.
2. Cấu hình riêng nằm ở `esp32_fire_guard/secrets.h`, cạnh `.ino`, được Git bỏ qua. Khi cấu hình máy mới, copy `secrets.example.h` thành file này và điền Wi-Fi, URL, device token. Không dùng mật khẩu đăng nhập web thay token. Token được cấp bằng API admin `POST /api/devices`; xem `../docs/BACKEND_API.md`.
3. Server: `http://192.168.1.102:3000/api/sensor-data`. Backend cần chạy `npm start`, `HOST=0.0.0.0`; hai máy cùng mạng, firewall cho phép Node trên mạng riêng. Nếu IP máy tính đổi, cập nhật `SERVER_URL` rồi nạp lại.
4. Cài board `esp32 by Espressif Systems`, thư viện `ArduinoJson`, `DHT sensor library` của Adafruit và `Adafruit Unified Sensor`.
5. Windows: dùng Sketchbook không dấu, ví dụ `D:\Arduino`, để tránh lỗi header trong đường dẫn OneDrive có dấu.
6. Chọn **ESP32 Dev Module**, COM của CP2102, Upload Speed **115200** nếu cần. Bấm **Verify** rồi **Upload**. Chỉ Verify chưa nạp code. Nếu kẹt `Connecting...`, giữ BOOT đến khi bắt đầu ghi.
7. Serial Monitor **115200 baud**, nhấn EN/RESET. Không in mật khẩu/token ra log.

HTTP qua LAN thử nghiệm chưa mã hóa device token; không chuyển tiếp cổng này ra Internet.

## Chân đang dùng

Đây là cấu hình theo code đã có; cần đối chiếu với dây thực tế trước khi cấp nguồn.

| Linh kiện | Chân tín hiệu |
|---|---|
| DHT11 DATA | GPIO4 |
| MQ-2 AO | GPIO34 (ADC1, chỉ đầu vào) |
| Cảm biến lửa DO, giả định phát hiện lửa ở mức LOW | GPIO18 |
| Active buzzer / driver, bật ở mức HIGH | GPIO23 |
| LED qua điện trở, bật ở mức HIGH | GPIO2 |

Các module chung GND. Không đưa tín hiệu 5V trực tiếp vào GPIO: MQ-2 cấp 5V cần chia áp/chuyển mức AO trước GPIO34; kiểm tra cả mức DO cảm biến lửa. Còi cần dòng lớn/nguồn 5V phải qua driver phù hợp. DHT rời cần điện trở kéo DATA lên mức phù hợp GPIO 3.3V. Nếu dùng DHT22, đổi `DHT_TYPE` trước khi nạp. Một số kit không có LED tích hợp ở GPIO2; dùng LED ngoài theo bảng nếu cần.

## Hoạt động và giới hạn

- Đọc/gửi mỗi 2,5 giây. DHT lỗi gửi `temperature:null, health:{temperature:"fault"}`; không thay bằng số đo giả.
- Một MQ-2 chỉ cho một tín hiệu analog. `smoke` và `gas` đều bằng ADC/4095×100 để tương thích API: cùng **một chỉ số tương đối**, không phải hai phép đo độc lập, phần trăm nồng độ hoặc ppm. Cần làm nóng, hiệu chuẩn và kiểm tra theo module.
- Không gửi timestamp/sequence khi chưa có đồng hồ đồng bộ/bộ đếm lưu bền; backend dùng thời điểm nhận. Chưa chống replay hoàn chỉnh ở firmware.
- Ngưỡng cục bộ: nhiệt độ **>60°C**, MQ-2 tương đối **>60**, hoặc lửa LOW bật còi trước khi gọi HTTP. Đây là ngưỡng prototype chưa được hiệu chuẩn với phần cứng. Đổi ngưỡng trên dashboard **chưa đồng bộ** các hằng số fallback này.
- Còi cũng bật theo phản hồi hợp lệ `alarmActive:true`. Chỉ HTTP thành công, `success:true`, `alarmActive:false`, DHT hợp lệ và không còn nguy hiểm cục bộ mới tắt còi. Mất Wi-Fi, lỗi HTTP/JSON hoặc alarm null giữ nguyên còi đang bật.
- LED nháy nhanh khi báo động; nháy chậm khi DHT lỗi/chưa liên lạc backend; sáng liên tục khi mẫu gần nhất hợp lệ và gửi thành công.
- HTTP đồng bộ có timeout, có thể làm chậm vòng đọc/nháy LED vài giây. Cảnh báo chốt chỉ nằm RAM, mất qua reset/mất điện. Chưa tự phát hiện được mọi lỗi đứt dây MQ-2/flame. Không dùng prototype thay hệ thống báo cháy chuyên dụng.

## Kiểm tra sau nạp

Thành công cần log `[WIFI] Connected` và `[HTTP 200] Data accepted`. Dashboard chỉ có số đo sau POST thực tế; đăng ký thiết bị chưa có dữ liệu sẽ offline.

| Log | Kiểm tra |
|---|---|
| Không kết nối Wi-Fi | SSID/mật khẩu/mạng của kit |
| HTTP connection failed | Server, IP, port, firewall |
| HTTP 401/403 | Token, trạng thái enabled của thiết bị |
| DHT FAULT | Loại DHT, dây DATA, điện trở, nguồn |
| HTTP 200 nhưng chưa thấy số đo | Thiết bị được chọn, phiên đăng nhập, trang dashboard |

Kiểm tra build không chứng minh đấu dây đúng, cảm biến chính xác hoặc còi hoạt động. Không gửi dữ liệu mô phỏng vào registry phần cứng để tuyên bố ESP32 đã kết nối.
