# Đánh giá khả năng tích hợp AI — Smart Fire Guard

> Cập nhật runtime 18/10/2026: model đã nạp và inference được ở chế độ giới hạn của Ultralytics (`weights_only=True`, known-class allow-list). Kiểm tra một JPEG trống synthetic và một ảnh lửa công khai chỉ xác nhận luồng chạy, không phải đánh giá Precision/Recall. Các nhận định “chưa chạy model” phía dưới thuộc snapshot audit ban đầu. Nguồn model và hiệu quả thực địa vẫn chưa được xác minh; xem [AI_RUNTIME_TROUBLESHOOTING.md](AI_RUNTIME_TROUBLESHOOTING.md).

Ngày: 18/10/2026 (Asia/Saigon). Kết luận: **chưa có dữ liệu độc lập đủ cơ sở để train hoặc công bố hiệu quả phát hiện cháy thực tế**. Có thể duy trì luật cảm biến làm cơ chế cảnh báo và tích hợp mô hình thị giác như một nguồn quan sát hỗ trợ, có trạng thái unavailable rõ ràng.

## 1. Bằng chứng đã kiểm tra

Đã đọc database bằng SQLite `mode=ro`, kiểm tra inventory repository, schema, phân bố giá trị/nguồn/nhãn, service inference, adapter Node, alarm engine và firmware. Không chạy migration trên DB thật, không sửa database/trọng số, không train model.

Audit có thể tái tạo bằng:

```powershell
python ai/audit_data.py --output docs/AI_DATA_AUDIT.json
```

[AI_DATA_AUDIT.json](AI_DATA_AUDIT.json) ghi checksum và số liệu snapshot. Đã xác nhận:

| Hạng mục | Kết quả |
|---|---|
| SQLite integrity | `ok` |
| Sensor rows | 10.657 |
| Nguồn | 10.657 `SIMULATION`, không có hàng hardware trong snapshot |
| Status | 10.626 NORMAL, 31 DANGER, không có WARN |
| Tỷ lệ DANGER | khoảng 0,291% **phân bố dữ liệu**, không phải metric AI |
| Event logs | 9; chưa phải nhãn sự cố được chuyên gia xác nhận |
| Timestamp thô | 03/10/2026 10:34:59 → 18/10/2026 08:32:49, quy ước UTC legacy |
| Thiếu/ngoài miền sensor | Không thấy trong bốn field ở snapshot này |
| Timestamp trùng / bước không tăng | 14 / 14 |
| Vector sensor trùng | 20 |
| Khoảng ngắt >10 giây | 11 |
| DANGER liên tiếp theo thứ tự row | 6 đoạn; **không chứng minh 6 sự cố độc lập** |
| Status khớp luật mặc định | 10.657/10.657 — kiểm tra tính nhất quán, không phải đánh giá model |
| Ảnh/video/annotation/held-out test trong repo | Chưa có |

Không có giá trị null hoặc ngoài miền không đồng nghĩa chất lượng ML tốt. Nguồn giả lập, thiếu device/session/incident identity ở schema legacy, ít đoạn nguy hiểm và tương quan thời gian khiến số hàng lớn hơn rất nhiều số bối cảnh độc lập. Firmware MQ-2 cung cấp chỉ số tương đối, gas suy từ smoke; chưa có chứng cứ hiệu chuẩn khí hoặc test cảm biến thực. Không suy từ snapshot này rằng phần cứng chưa từng chạy ở môi trường khác.

## 2. `best.pt` có gì, chưa biết gì?

- 24.483.111 bytes, SHA-256 `ce0bd6adac82656d43db43676b60c95d6eb6729782a6ead7fe9565097ad0f25b`.
- Opcode metadata `names` khai báo `{0: fire, 1: smoke}`. Đã inspect ZIP/pickle instructions **không unpickle hoặc thực thi checkpoint**.
- Không xác minh backbone/phiên bản kiến trúc, train dataset, license, các scene đã thấy, labels thật, chất lượng, tốc độ hay khả năng tổng quát hóa. Tên `best.pt` không phải bằng chứng model tốt nhất trên một test set độc lập.
- Không sử dụng số metric có thể có trong checkpoint như kết quả kiểm chứng của dự án.
- [model_card.json](../ai/model_card.json) để tất cả metric hiệu quả ở `null`, trạng thái `unvalidated_candidate`.

PyTorch cảnh báo cơ chế load có liên quan unpickling; chỉ nạp checkpoint đã kiểm tra nguồn tin cậy. Service mới yêu cầu operator xác nhận hash artifact trước khi load; **hash chỉ kiểm tra đúng file, không chứng minh nguồn dữ liệu hoặc hiệu quả**. Tham khảo [torch.load](https://docs.pytorch.org/docs/2.14/generated/torch.load.html).

## 3. Bài toán nào phù hợp?

| Bài toán | Target/đầu vào | Quyết định hiện tại |
|---|---|---|
| Cảnh báo theo ngưỡng | So sánh temperature/smoke/gas/flame với luật cấu hình | Tiếp tục dùng; không gọi là model học từ dữ liệu |
| Phát hiện lửa/khói đang thấy | Ảnh → lớp fire/smoke + bounding box + detection score | Hướng tích hợp phù hợp stack đang có, nhưng checkpoint chỉ là ứng viên chưa được đánh giá |
| Phân loại nguy cơ từ cảm biến | Cửa sổ telemetry quá khứ → nhãn độc lập normal/hazard | Chưa train: thiếu ground truth thật và nhóm sự kiện |
| Dự báo cháy trong tương lai | Cửa sổ trước thời điểm t → sự cố trong (t,t+H] | Chưa đủ event onset, chuỗi thật và định nghĩa horizon; không thể suy từ labels hiện tại |
| Phát hiện bất thường | Telemetry lệch khỏi phân bố vận hành thật đã biết | Chỉ cân nhắc sau khi thu normal thật; anomaly không đồng nghĩa cháy |

Ưu tiên hiện tại là **visual evidence ở hiện tại**, không gắn nhãn đầu ra là xác suất cháy sắp xảy ra. Detection score không phải accuracy của model, cũng chưa được hiệu chuẩn thành xác suất xảy ra cháy. Negative chỉ là không có detection đủ score trong ảnh đó, không chứng nhận an toàn khu vực ngoài camera.

## 4. Luật ngưỡng khác AI như thế nào?

`alarmLevel()` thực hiện luật do con người đặt: flame hoặc chỉ số >DANGER → bad; sensor fault không có bằng chứng danger → unknown; >WARN → warn. Các hệ số/ngưỡng này không được học qua tối ưu loss trên dữ liệu.

Train một classifier dùng temperature/smoke/gas/flame để đoán `status` hiện tại rồi chấm trên chính status sẽ học lại phép so sánh. Đây là nhãn vòng tròn, không phải kiểm chứng cháy. Dùng status/alarmActive/buzzerCommand/event message làm feature hoặc trộn các frame/cửa sổ cùng sự kiện giữa train/test còn gây leakage.

YOLO có tham số được học từ dữ liệu ảnh và annotation. Tuy nhiên, repository không cung cấp quá trình học/held-out ground truth của checkpoint; không có cơ sở biến score trả về thành một cam kết hiệu quả trên ESP32.

## 5. Đề xuất mô hình theo điều kiện dữ liệu

- **Ngay bây giờ:** giữ rule engine; không train classifier cảm biến từ dataset SIMULATION. Kiểm thử DEMO chỉ chứng minh wiring/code/contracts, không field performance.
- **Ảnh đã có nhãn và có quyền dùng:** fine-tune ứng viên Ultralytics phù hợp tài nguyên, giữ framework hiện có. Chỉ khởi tạo từ checkpoint có nguồn rõ ràng, tránh tự chuyển sang kiến trúc mới chỉ vì phiên bản thư viện hỗ trợ. So sánh baseline checkpoint và fine-tuned model trên cùng external holdout.
- **Telemetry thật có nhãn độc lập nhưng còn ít nhóm:** bắt đầu logistic regression hoặc cây nông, sau đó cân nhắc random forest; fit imputer/scaler/class weights chỉ trên train. Đây là đề xuất tương lai, chưa cài thêm sklearn hay tạo model giả trong lượt này.
- **Chưa có nhãn nhưng có normal thật:** có thể thử robust statistics/Isolation Forest như cảnh báo bất thường phụ; cần đánh giá false alarms trên phiên mới. Không dùng score anomaly để tắt còi hoặc tự kết luận có cháy.
- Chưa có lý do dùng LSTM/Transformer, model đa modal phức tạp hay thay cả stack với dataset hiện tại. Số mẫu/nhóm và độ phủ lớp cần quyết định theo pilot + khoảng tin cậy, không áp một con số ảnh tùy ý rồi tuyên bố “đủ”.

Tham khảo khả năng [train](https://docs.ultralytics.com/modes/train/) và [validation](https://docs.ultralytics.com/modes/val/) từ Ultralytics. Đây là hướng dùng API hiện có, không phải kết quả train đã đạt.

## 6. Thiết kế inference và fallback đã triển khai

Luồng: webcam có consent → Socket.IO operator/admin → Node adapter (timeout/frameId/freshness) → Flask `/detect` → advisory về đúng socket. Không có đường AI sửa threshold, số đo hoặc `alarmActive` của thiết bị.

Flask giữ `hasFire`/`confidence` để tương thích, bổ sung `available`, `decision`, `detections`, frame/time IDs, metadata hash/model, score cutoff, `advisoryOnly` và fallback. Box theo pixel ảnh đầu vào; fire/smoke vẫn tách label, hasFire là legacy tên field gộp cả hai loại evidence. Health 503 nếu model thiếu, chưa được operator tin cậy, load lỗi hoặc không đúng classes.

Node không chấp nhận response sai schema, nhầm frameId, timestamp không khớp, kết quả quá cũ, timeout hoặc HTTP lỗi thành negative. Khi lỗi: available=false, hasFire=null. Hold 10 giây theo socket/camera quan sát là trạng thái duy trì, **không phải detection mới**; confidence của trạng thái held là null. UI hiển thị score chưa hiệu chuẩn và tiếp tục dùng luật cảm biến.

| Sensor evidence | AI | Quyết định phần cứng và UI |
|---|---|---|
| DANGER hợp lệ | Negative / unavailable / positive | Rule engine giữ bad, command ON |
| Trong ngưỡng hợp lệ | Positive | Hardware theo rule; advisory yêu cầu kiểm tra, không AI-only ON |
| Sensor fault/stale | Positive/negative/unavailable | Unknown, giữ số đo/lastKnownLevel; fault cần kiểm tra, không suy safe từ AI |
| Sensor unknown | Bất kỳ | Khi có response telemetry unknown: `alarmActive:null`, command HOLD, không tự OFF |
| Thiết bị offline | Bất kỳ | Không có command HTTP mới; local fail-safe thuộc firmware, chưa được hoàn thiện/chứng nhận |

AI ở đây **không phải cơ chế duy nhất kích hoạt hoặc vô hiệu hóa báo cháy**. Chưa có binding camera→device/zone đã xác minh, nên chưa ghép positive AI thành lệnh cho một ESP32. Mở rộng fusion sau này cần zone identity, evidence policy, xác nhận độc lập và kiểm thử nguy cơ; negative AI tuyệt đối không xóa sensor danger.

## 7. Kết quả thực sự đã có

- Audit dữ liệu và checkpoint tĩnh; không nạp trọng số, không train, không tạo predicted outputs cho database mô phỏng.
- Công cụ chuẩn bị split chặn dữ liệu tự khai báo simulation/rule labels, kiểm tra group/time/hash/near-duplicate heuristic; không thể tự chứng minh người gán nhãn nói thật. Curator phải kiểm tra provenance.
- Công cụ đánh giá nhận truth độc lập và predictions đủ coverage, trả Precision/Recall/F1, confusion matrix có cột unavailable, metrics per-class presence; không tự điền negative cho record thiếu.
- Test dùng model/ảnh/số liệu **DEMO fixtures** để xác minh code, không dùng làm bằng chứng hiệu quả thực tế. Xem [hướng dẫn train và đánh giá](AI_TRAINING_AND_EVALUATION.md).

**Precision, Recall, F1, Confusion Matrix thực tế của `best.pt`: chưa có.** Mọi trường tương ứng trong model card được để null. Dataset/trọng số hiện tại chưa đủ căn cứ cho tuyên bố triển khai báo cháy ngoài thực địa.
