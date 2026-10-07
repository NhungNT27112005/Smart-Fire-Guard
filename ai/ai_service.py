import base64
import cv2
import numpy as np
from flask import Flask, request, jsonify
from ultralytics import YOLO

app = Flask(__name__)

# Load mô hình YOLOv8 từ file best.pt nằm cùng thư mục
model = YOLO("best.pt")

@app.route("/detect", methods=["POST"])
def detect():
    data = request.json
    image_b64 = data.get("image", "")
    
    # Lọc bỏ header của chuỗi base64 (nếu có)
    if ',' in image_b64:
        image_b64 = image_b64.split(',')[1]

    # Giải mã hình ảnh
    img_bytes = base64.b64decode(image_b64)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    # Chạy AI nhận diện
    results = model(img, conf=0.15)[0]

    has_fire = False
    max_conf = 0.0

    # Lọc kết quả tìm class 'fire' hoặc 'smoke'
    for box in results.boxes:
        cls_id = int(box.cls[0])
        class_name = model.names[cls_id]
        
        if class_name in ['fire', 'smoke']:
            has_fire = True
            conf = float(box.conf[0]) * 100
            if conf > max_conf:
                max_conf = conf

    return jsonify({
        "hasFire": has_fire,
        "confidence": round(max_conf, 1)
    })

if __name__ == "__main__":
    # Chạy ở cổng 5000
    app.run(port=5000)