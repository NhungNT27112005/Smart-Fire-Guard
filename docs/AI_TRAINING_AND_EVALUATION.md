# Quy trình dữ liệu, train, đánh giá và inference

> Cập nhật runtime 18/10/2026: có chế độ nạp giới hạn `AI_MODEL_LOAD_MODE=restricted`, khởi động bằng `npm run start:ai` để đọc `.env`. Đã kiểm tra inference thực với một JPEG trống synthetic và một ảnh lửa công khai; chưa có đánh giá độc lập chất lượng model. Các kết quả audit/test lịch sử bên dưới giữ nguyên ngữ cảnh. Xem [hướng dẫn runtime](AI_RUNTIME_TROUBLESHOOTING.md).

Ngày: 18/10/2026. **Chưa chạy train:** dataset đang có chỉ là SIMULATION và nhãn từ luật, không có ảnh/annotation/nhãn sự cố độc lập. Các bước train bên dưới chỉ thực hiện sau khi đáp ứng điều kiện dữ liệu và kiểm tra nguồn model.

## 1. Thu thập và gán nhãn

Vision: lưu ảnh gốc và YOLO boxes cho hai lớp fire=0, smoke=1; negative là annotation rỗng đã được người gán nhãn kiểm tra, không phải lỗi/mất file annotation. Thu cả bối cảnh khó: ánh sáng đỏ, phản chiếu, hơi nước, bụi, đèn, hoàng hôn, nguồn nhiệt không cháy, che khuất và khói mỏng. Không tạo nguy cơ cháy để thu dataset; dùng quy trình/nguồn dữ liệu được phép, có giám sát phù hợp.

Mỗi sample cần sample_id, group_id, session_id, incident_id nếu có, site_id, camera_id, captured_at có timezone, provenance/quyền dùng, label_origin và reviewed. Tất cả frame cùng video/capture session/sự cố phải cùng nhóm dù ở camera khác. Các ID session/incident dùng duy nhất toàn manifest. Có người review annotation thứ hai và quy tắc xử lý bất đồng/uncertain; không dùng model prediction làm ground truth mà không review độc lập.

Telemetry tương lai: thu device ID, loại/calibration/health sensor, UTC timestamps, sampling gaps và onset/end của sự cố do người xác minh độc lập. Tách hoạt động bình thường, sự cố sensor, hơi nước/nấu ăn và sự kiện liên quan cháy. Status của backend chỉ là decision log, không phải nhãn thực địa. Không suy xác suất cháy từ gas % tương đối chưa hiệu chuẩn.

## 2. Manifest và chuẩn bị split

Không có manifest thật được thêm vào repo. Ví dụ dưới đây chỉ mô tả schema; đường dẫn/ID là placeholder và **không phải dữ liệu huấn luyện**:

```json
{"sample_id":"REPLACE_SAMPLE_ID","image":"images/REPLACE.jpg","annotation":"labels/REPLACE.txt","group_id":"REPLACE_GROUP","session_id":"REPLACE_SESSION","incident_id":null,"site_id":"REPLACE_SITE","camera_id":"REPLACE_CAMERA","captured_at":"REPLACE_ISO_TIMESTAMP","source":"real","label_origin":"independent_human","reviewed":true,"provenance":"REPLACE_WITH_DATA_OWNER_LICENSE_AND_COLLECTION_RECORD"}
```

Chỉ đặt source=real/reviewed=true khi curator đã xác minh thực sự. Đổi metadata của ảnh mô phỏng không biến ảnh đó thành bằng chứng thật. Công cụ kiểm tra schema không xác minh được tính trung thực của lời khai hay license.

Dataset layout phù hợp Ultralytics: `images/.../name.jpg` và `labels/.../name.txt`, cùng stem và thư mục con. Annotation YOLO: `class_id x_center y_center width height` chuẩn hóa [0,1], box nằm trong ảnh; không nhận unknown class.

```powershell
python ai/prepare_dataset.py D:/collected-data/manifest.jsonl --output .tmp/ml-splits --embargo-seconds 60
```

Công cụ kiểm tra:

- Source real, label_origin independent_human, reviewed=true và metadata nhóm/time/provenance đầy đủ.
- File nằm trong thư mục manifest, annotation matching images/labels, IDs/hash không trùng.
- Toàn nhóm được xếp theo thời điểm đầu nhóm; mặc định xấp xỉ 70/15/15 theo **nhóm**, giữ ít nhất một nhóm mỗi partition. Không random split từng frame.
- Timestamp của train/validation/test không chồng lấn, cách boundary hơn embargo đã chỉ định. Với dataset sensor cửa sổ dài hơn, embargo phải ≥ chiều dài lookback + horizon; 60s chỉ là default chuẩn bị ảnh, không phải bảo đảm vật lý cho mọi dataset.
- Mỗi partition phải có support fire, smoke và reviewed negative. Tối thiểu ba nhóm chỉ là điều kiện cấu trúc của splitter, **không phải số lượng đủ để khẳng định hiệu quả**. Cần nhiều phiên/sự cố độc lập và bối cảnh đại diện trước khi train/báo cáo.
- Exact duplicate bị chặn. dHash Hamming distance ≤4 giữa split bị coi là nghi vấn và chặn để review. Heuristic có thể bỏ sót near-duplicates hoặc báo nhầm; không thay review video/scene/provenance. So sánh cặp có độ phức tạp bậc hai, phù hợp tập nhỏ; dataset lớn cần công cụ lập chỉ mục/curation riêng.

Đầu ra gồm `splits.json` (hash ảnh/annotation), train/validation/test.txt và dataset.yaml; **không train, không tạo số metric**. Nếu thiếu lớp/nhóm, thu thập thêm hoặc sửa lỗi dữ liệu có lý do, không đổi split liên tục để tìm điểm test đẹp. Giữ external test chưa được dùng trong phát triển; pretrained checkpoint không rõ nguồn vẫn có rủi ro đã thấy test scene.

## 3. Leakage cần tránh

Không dùng status, alarmActive, buzzerCommand, source simulation, thông báo event hay dữ liệu tương lai làm feature để dự đoán nhãn cháy độc lập. Không chia các frame liền kề, ảnh augment từ cùng ảnh gốc, các cửa sổ telemetry chồng nhau hoặc cùng incident qua train/test. Deduplicate và group **trước** augmentation.

Fit scaler/imputer/feature selector chỉ trên train; tuning model, score cutoff và policy temporal hold dùng validation. Không resample/SMOTE hoặc chọn feature trước split trên toàn dataset. Với telemetry dự báo trong (t,t+H], feature chỉ lấy đến t; event boundaries phải do người xác minh. Group theo site/device nếu mục tiêu là tổng quát sang site/device mới; splitter hiện tại là chronological incident/session holdout, chưa tự tạo unseen-site benchmark.

Thiết kế split dựa trên nguyên tắc của [scikit-learn grouped/time-aware validation](https://scikit-learn.org/stable/modules/cross_validation.html). Trong dự án chưa cài sklearn vì chưa có dataset trainable.

## 4. Train khi dữ liệu đáp ứng điều kiện

1. Chốt task: object detection/presence hiện tại; chưa gọi là dự báo tương lai. Curator duyệt provenance, labels, bối cảnh và số nhóm, sau khi qua các kiểm tra tự động.
2. Freeze manifest/split hashes, checkpoint nguồn đã tin cậy, class order, dependency versions, seed và cấu hình train. Không tải weights/dataset tự động từ nguồn chưa được duyệt.
3. Với Ultralytics hiện có, ví dụ API **chưa được chạy trong lượt này**:

```python
from ultralytics import YOLO

if __name__ == "__main__":
    # Replace with a local checkpoint whose provenance and loading safety were reviewed.
    model = YOLO("PATH_TO_TRUSTED_INITIAL_WEIGHTS.pt")
    model.train(data="PATH_TO_PREPARED/dataset.yaml", epochs=50, imgsz=640,
                seed=42, deterministic=True, project=".tmp/ml-runs", name="candidate")
```

50 epochs/640 là điểm bắt đầu minh họa, không phải cấu hình tối ưu đã tìm thấy. Dừng sớm/chọn checkpoint dựa validation; ghi hardware, wall time, losses và thay đổi cấu hình. Seed không bảo đảm tái lập bit-for-bit trên mọi phần cứng/runtime. Dùng main guard trên Windows theo [Ultralytics train docs](https://docs.ultralytics.com/modes/train/).

4. Chọn score cutoff bằng precision–recall trên validation, cân nhắc recall/false alarms theo yêu cầu đã thống nhất. Không chọn cutoff bằng test. Cutoff đang chạy 0.15 chỉ là inherited experimental setting, chưa được chứng minh tối ưu.
5. Freeze checkpoint và cutoff. Đánh giá test một lần theo protocol; nếu tiếp tục điều chỉnh sau khi xem test, tập đó trở thành development data và cần external holdout mới. Tránh báo cáo “best of many test attempts”.

## 5. Đánh giá đúng task

Với binary frame presence, ground truth dương khi annotation chứa fire hoặc smoke. Các công thức theo [metric definitions](https://scikit-learn.org/stable/modules/model_evaluation.html#precision-recall-f-measure-metrics): Precision=TP/(TP+FP), Recall=TP/(TP+FN), F1=2TP/(2TP+FP+FN). Mẫu số 0 → null/undefined với giải thích, không tự bịa 100%.

Đối với object detection, phải thêm per-class box matching theo IoU/NMS đã freeze, mAP@0.5 và mAP@0.5:0.95, confusion matrix detection có background. Dùng `model.val(data=..., split="val"/"test", plots=True)` theo [Ultralytics validation](https://docs.ultralytics.com/modes/val/). Công cụ bên dưới tính **presence metrics**, không thay thế localization/mAP. Báo cáo rõ threshold mà Ultralytics dùng cho từng plot/metric; không trộn P/R ở cutoff tự chọn với mAP tích phân rồi coi là cùng phép đo.

Lưu predictions cho từng sample từ model thật, gồm sample_id, available, hasFire, detected_labels, model_sha256 và confidence_threshold. Unavailable phải có hasFire=null, detected_labels=null. Không lấy `hasFire` đã temporal hold làm raw per-frame prediction; nếu đánh giá temporal policy, phải định nghĩa riêng protocol theo event/time. Prediction file phải bao phủ đúng mọi sample của split, không bỏ ảnh AI lỗi.

```powershell
python ai/evaluate.py .tmp/ml-splits/splits.json PATH_TO_REAL_PREDICTIONS.jsonl --split test --output .tmp/ml-results/test.json
```

Evaluator kiểm tra overlap group/session/incident/hash giữa split, kiểm lại hash file/annotation và class truth đã freeze, từ chối prediction thiếu/trùng/khác model/cutoff. Nó không chứng minh predictions được tạo trung thực từ checkpoint hoặc metadata provenance là thật; lưu raw inference outputs và audit script/config đi kèm để reviewer kiểm tra.

Kết quả:

- Confusion matrix 2×3: true rows no_hazard/hazard, predicted columns no_detection/hazard/unavailable. Không đánh đồng unavailable với negative.
- Precision/Recall/F1 chỉ trên predictions khả dụng được gắn nhãn `available_only`, luôn kèm coverage.
- `end_to_end_detection_recall` tính TP/tất cả positive, bao gồm positive bị AI unavailable như missed detection. Coverage thấp không được che bằng metric trên phần nhỏ model trả lời được.
- Per-class presence cho fire/smoke và group-any-presence riêng. Nhóm không có positive prediction nhưng còn frame unavailable là unknown, không safe-negative.
- Support từng lớp/nhóm. Nếu một lớp không có support ở event level, báo undefined và thu thêm dữ liệu; không diễn giải absence thành hiệu quả cao.

Ngoài các metric này cần đo false alerts/camera-hour trên video bình thường liên tục, detection delay theo incident onset, FP/FN theo ánh sáng/site/camera, latency p50/p95 trên máy triển khai và tỉ lệ unavailable. Confidence intervals/bootstrap theo **incident/site**, không theo hàng/frame tương quan. Chưa có dữ liệu để tính những giá trị này.

Không dùng accuracy làm headline trong dataset lệch lớp như snapshot hiện tại. Không dùng metric từ SIMULATION để tuyên bố hiệu quả trên thiết bị thật. Đây là protocol, **không có kết quả Precision/Recall/F1/Confusion Matrix thực địa được tạo trong lượt này**.

## 6. Chạy inference ứng viên có kiểm soát

Service đọc process environment của Python; Node `.env` không tự truyền sang một process Python được chạy ở terminal khác. Sau khi operator đã kiểm tra nguồn/trust của checkpoint, thiết lập hash đúng file trong terminal chạy Python:

```powershell
$env:AI_MODEL_PATH = (Resolve-Path ai/best.pt).Path
# Assign only AFTER independently reviewing checkpoint origin/loading safety.
$env:AI_TRUSTED_MODEL_SHA256 = (Get-FileHash $env:AI_MODEL_PATH -Algorithm SHA256).Hash.ToLowerInvariant()
$env:AI_CONFIDENCE_THRESHOLD = "0.15"
$env:AI_MAX_FRAME_AGE_MS = "5000"
python ai/ai_service.py
```

Tính hash rồi tự gán không tự xác minh provenance; lệnh minh họa bước pin integrity sau review. Khi trust hash để trống/sai, `/health` và request hợp lệ `/detect` trả 503; checkpoint không bị load. Model card vẫn unvalidated cho đến khi có external evaluation đáng tin cậy; service không tự đổi thành “validated” chỉ vì khởi động được.

Request tới loopback `POST /detect`, JSON:

```json
{"image":"data:image/jpeg;base64,REPLACE_WITH_JPEG_BASE64","frameId":"REPLACE_FRAME_ID","capturedAt":"REPLACE_CURRENT_ISO_TIMESTAMP"}
```

frameId/capturedAt tùy chọn với client trực tiếp; Node adapter luôn cấp chúng. Giới hạn JSON 512KiB, image string 450.000 ký tự, JPEG ≤2048×2048; serialized inference, timestamp age/future check, HTTP 422 stale frame/503 unavailable-busy-late. Response có available/hasFire/confidence, decision risk_detected/no_detection, boxes/class scores, model hash/status/cutoff, latencyMs, completedAt và `advisoryOnly:true`. Schema chưa được gán nhãn như một xác suất cháy.

Node kiểm tra frameId, timestamp, timeout và schema, giữ hold theo socket, xóa state khi disconnect/shutdown. HTTP lỗi/schema/late/timeout → available=false, hasFire=null và fallback sensor_rules, không synthetic negative. Model confidence held là null để không giả điểm mới. `AI_HOLD_MS` mặc định 10.000, `AI_MAX_FRAME_AGE_MS` mặc định 5.000; tuning chỉ sau validation và không ảnh hưởng luật còi.

Giữ Flask loopback, auth/role/rate limit ở Node gateway, không expose port 5000 trực tiếp. Không tự lưu webcam frames. Chưa có camera→zone/device mapping đã xác minh nên **không ghép AI vào hardware commands**. Khi AI hỏng, thiết bị còn liên lạc vẫn dùng threshold/fault rules như trước; khi thiết bị offline không giả vờ server điều khiển được còi.

## 7. Tests và khả năng tái kiểm chứng

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py" -v
python ai/audit_data.py --output docs/AI_DATA_AUDIT.json
```

Các fixture kiểm thử đều là DEMO synthetic/stub, chỉ kiểm tra contracts, arithmetic và điều kiện chặn: rule boundaries, grouped split/embargo/class support, reject simulation, score undefined/abstention, frame mismatch/stale, timeout/shutdown, per-camera hold, model trust/classes/output validity và sensor rules độc lập. Không có model fitting trong tests và không dùng số test pass làm bằng chứng model hiệu quả.

Lượt kiểm tra đã gặp PermissionError ở thư mục temp của Python trong sandbox; chạy lại cùng bộ tests ngoài sandbox đã pass. Database gốc và hash checkpoint được giữ nguyên. Chưa chạy model thật, training, field trial, camera/ESP32 hay benchmark latency; chỉ latency trong service response được đo cho request cụ thể, không phải báo cáo benchmark của `best.pt`.

Kết quả cuối cùng: `npm test` **27/27 pass** (5 adapter AI, 13 backend/integration/config, 9 frontend); Python unittest **15/15 pass** (8 Flask contract, 7 công cụ ML). Kiểm tra cú pháp, liên kết/fence Markdown và `git diff --check` pass. Checksum DB vẫn `40deca27a9ccbeea06992c3468a42812e2c9208b292eaca960dd8b0a68a348c6`; checksum weights vẫn như model card. Đây là kết quả kiểm thử phần mềm, không phải Precision/Recall/F1 của model thực tế.
