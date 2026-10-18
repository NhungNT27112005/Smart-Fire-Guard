# Chạy và kiểm tra AI camera

## Nguyên nhân đã xác nhận ngày 18/10/2026

`GET http://127.0.0.1:5000/health` ban đầu trả HTTP 503, `reason:MODEL_NOT_TRUSTED`. Flask vẫn chạy nhưng checkpoint không được nạp. Dashboard đã che nguyên nhân thành “AI không khả dụng”, nên không thể suy ra model nhận diện sai ảnh.

Nguồn `ai/best.pt` chưa được người dùng xác minh. Không tự gán hash thành “đáng tin cậy”. Trọng số giữ nguyên SHA-256 trong model card; không train hoặc công bố accuracy.

## Chế độ giới hạn

```dotenv
AI_MODEL_LOAD_MODE=restricted
AI_MODEL_PATH=./ai/best.pt
AI_CONFIDENCE_THRESHOLD=0.15
AI_MAX_FRAME_AGE_MS=5000
```

Chạy hai terminal từ root repository:

```powershell
npm start
```

```powershell
npm run start:ai
```

Launcher Node đọc `.env` rồi truyền môi trường sang Python. Nếu dùng Python ở đường dẫn riêng, đặt `AI_PYTHON_EXECUTABLE` bằng đường dẫn file python.exe. Chạy `python ai/ai_service.py` trực tiếp vẫn cần tự thiết lập process environment.

Chế độ restricted bật `ULTRALYTICS_SAFE_LOAD=true` trước khi import, xác nhận `_SafeLoad.SUPPORTED` và cờ `SAFE_LOAD` thực sự bật. Ultralytics sử dụng `torch.load(weights_only=True)` với danh sách lớp đã biết. Nếu phiên bản thư viện không hỗ trợ, service trả `RESTRICTED_LOADER_UNAVAILABLE`; không hạ xuống unrestricted pickle. Nếu checkpoint chứa kiểu không được hỗ trợ hoặc lỗi nạp, trả `MODEL_LOAD_FAILED`.

Đây là giảm rủi ro khi nạp, không phải sandbox hoàn chỉnh, xác minh nguồn, giấy phép hay bảo đảm không có vấn đề tài nguyên. Không tự mở rộng allow-list dựa vào nội dung checkpoint. Dùng runtime/dependencies được cập nhật, service chỉ bind loopback. Tham khảo [Ultralytics restricted loader](https://docs.ultralytics.com/reference/nn/tasks/) và [PyTorch serialization](https://docs.pytorch.org/docs/stable/notes/serialization.html).

Chế độ `trusted` vẫn giữ cơ chế hash: chỉ nạp thông thường khi `AI_TRUSTED_MODEL_SHA256` khớp, sau khi operator đã kiểm tra nguồn. Không sử dụng chế độ này cho file chưa rõ nguồn.

## Xác minh

1. `/health` phải HTTP 200, `modelReady:true`, `loadingMode:restricted`, classNames có fire và smoke.
2. Tải lại dashboard, đăng nhập operator/admin, bật camera. Browser gửi JPEG qua Socket.IO → Node → Flask.
3. Lỗi model/timeout/kết nối phải hiển thị nguyên nhân, không biến thành “không có lửa”. Phản hồi inference có `validationStatus:unvalidated_candidate` và `provenanceVerified:false`.
4. Dùng ảnh/video được phép để thử, không tạo đám cháy để kiểm tra ứng dụng. Negative AI không xác nhận an toàn; AI không điều khiển hoặc tắt còi cảm biến.

## Kết quả kiểm tra runtime, không phải benchmark

- Model gốc, Ultralytics 8.4.174, Torch 2.14.1: nạp thành công bằng restricted loader.
- JPEG trống **SYNTHETIC**, 640×360: HTTP 200, `no_detection`. Chỉ kiểm tra pipeline.
- Một ảnh campfire công khai: HTTP 200, `hasFire:true`, hai box nhãn fire. Ảnh [Fire.jpg](https://commons.wikimedia.org/wiki/File:Fire.jpg), tác giả ltfhenry, nguồn khai báo public domain; resize 640×480 và nén JPEG để đúng giới hạn API. File và response nằm trong `.tmp/ai-fire-public*`, không nhập vào dataset/test split.
- Một ảnh không có split độc lập, annotation chuẩn hoặc kiểm soát overlap training. Không tính accuracy/Precision/Recall/F1 từ kiểm tra này, không suy hiệu quả trên webcam hoặc đám cháy thực tế.
- Luồng Socket.IO có session thật → Node adapter → Python restricted → `ai_result`: PASS với ảnh công khai trên, `available:true`, `observedHasFire:true`, `affectsHardware:false`. Chưa kiểm tra webcam của người dùng trực tiếp.
- Tests phần mềm: `npm test` **29/29 pass**, Python `test_ai_service.py` **10/10 pass**. Fixtures unit/integration là DEMO/stub, không dùng số test pass làm metric mô hình.

Khởi động lại backend Node sau thay đổi adapter để cập nhật mã lỗi, tải lại trang để nhận UI mới. Mỗi lần chạy cần giữ cả Node và Python hoạt động.
