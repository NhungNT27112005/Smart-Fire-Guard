"""Advisory vision inference. No classification output is a hardware alarm command."""
import base64
import binascii
import hashlib
import io
import math
import os
from pathlib import Path
import threading
import time
from datetime import datetime, timezone
from uuid import uuid4

import cv2
import numpy as np
from flask import Flask, jsonify, request
from PIL import Image, UnidentifiedImageError
from werkzeug.exceptions import HTTPException


class RestrictedLoaderUnavailable(RuntimeError):
    pass


def load_restricted_model(path):
    """Opt in to the installed library's known-class, weights-only loader.

    Never fall back to unrestricted pickle loading on old library/torch versions.
    This reduces loading risk; it does not establish provenance or model quality.
    """
    os.environ["ULTRALYTICS_SAFE_LOAD"] = "true"
    from ultralytics.nn import tasks
    if not (getattr(getattr(tasks, "_SafeLoad", None), "SUPPORTED", False)
            and getattr(tasks, "SAFE_LOAD", False)):
        raise RestrictedLoaderUnavailable("Restricted checkpoint loader is not active")
    from ultralytics import YOLO
    return YOLO(str(path))


def create_app(model=None, settings=None, clock=time.time):
    settings = settings or {}
    threshold = float(settings.get("threshold", os.environ.get("AI_CONFIDENCE_THRESHOLD", "0.15")))
    max_age_ms = int(settings.get("max_age_ms", os.environ.get("AI_MAX_FRAME_AGE_MS", "5000")))
    if not math.isfinite(threshold) or not 0 < threshold < 1 or not 100 <= max_age_ms <= 30000:
        raise ValueError("Invalid AI confidence threshold or maximum frame age")
    path = Path(settings.get("model_path", os.environ.get("AI_MODEL_PATH", str(Path(__file__).resolve().with_name("best.pt")))))
    expected = settings.get("trusted_sha256", os.environ.get("AI_TRUSTED_MODEL_SHA256", ""))
    load_mode = settings.get("load_mode", os.environ.get("AI_MODEL_LOAD_MODE", "trusted"))
    if load_mode not in ("trusted", "restricted"):
        raise ValueError("AI_MODEL_LOAD_MODE must be trusted or restricted")
    checksum = None
    unavailable_code = None
    injected = model is not None
    if model is None:
        if not path.is_file():
            unavailable_code = "MODEL_MISSING"
        else:
            checksum = hashlib.sha256(path.read_bytes()).hexdigest()
            # Loading a PyTorch pickle can execute code. Hash matching is an explicit
            # operator trust decision, not proof of training provenance or performance.
            if load_mode == "restricted":
                try:
                    model = load_restricted_model(path)
                except RestrictedLoaderUnavailable:
                    unavailable_code = "RESTRICTED_LOADER_UNAVAILABLE"
                except Exception:
                    unavailable_code = "MODEL_LOAD_FAILED"
            elif not expected or checksum != expected:
                unavailable_code = "MODEL_NOT_TRUSTED"
            else:
                try:
                    from ultralytics import YOLO
                    model = YOLO(str(path))
                except Exception:
                    unavailable_code = "MODEL_LOAD_FAILED"
    try:
        declared = getattr(model, "names", {}) or {}
        items = enumerate(declared) if isinstance(declared, list) else declared.items()
        names = {int(k): str(v).lower() for k, v in items}
    except (TypeError, ValueError, AttributeError):
        names = {}
    if model is not None and not {"fire", "smoke"}.issubset(set(names.values())):
        model = None
        unavailable_code = "MODEL_CLASS_MISMATCH"
    metadata = {"sha256": checksum, "classNames": names, "validationStatus": "test_double" if injected else "unvalidated_candidate",
                "loadingMode": "test_double" if injected else load_mode, "provenanceVerified": False,
                "confidenceThreshold": threshold, "confidenceIsCalibratedProbability": False}
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 512 * 1024
    inference_lock = threading.Lock()

    def error(code, message, status):
        return jsonify(success=False, available=False, hasFire=None, confidence=None,
                       decision="unavailable", requestId=str(uuid4()), model=metadata,
                       fallback={"mode": "sensor_rules", "affectsHardware": False},
                       error={"code": code, "message": message}), status

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return error("HTTP_ERROR", exc.name, exc.code)

    @app.errorhandler(Exception)
    def unexpected_error(exc):
        app.logger.error("AI service failed: %s", type(exc).__name__)
        return error("AI_ERROR", "Inference service failed", 500)

    @app.get("/health")
    def health():
        return jsonify(success=model is not None, modelReady=model is not None,
                       available=model is not None, model=metadata, reason=unavailable_code), 200 if model is not None else 503

    @app.post("/detect")
    def detect():
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or "image" not in data or set(data) - {"image", "frameId", "capturedAt"}:
            return error("VALIDATION_ERROR", "Expected JSON image and optional frameId/capturedAt", 400)
        frame_id = data.get("frameId", str(uuid4()))
        if not isinstance(frame_id, str) or not 1 <= len(frame_id) <= 100 or any(ord(c) < 32 for c in frame_id):
            return error("VALIDATION_ERROR", "Invalid frameId", 400)
        captured = clock()
        if "capturedAt" in data:
            try:
                value = data["capturedAt"]
                if not isinstance(value, str) or len(value) > 64:
                    raise ValueError()
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError()
                captured = parsed.timestamp()
            except (ValueError, TypeError, OverflowError):
                return error("VALIDATION_ERROR", "capturedAt needs an ISO timestamp with timezone", 400)
            age = (clock() - captured) * 1000
            if age < -1000 or age >= max_age_ms:
                return error("STALE_FRAME", "Frame timestamp is stale or in the future", 422)
        encoded = data["image"]
        if not isinstance(encoded, str) or len(encoded) > 450000:
            return error("VALIDATION_ERROR", "Expected bounded JPEG base64", 400)
        if encoded.startswith("data:"):
            if not encoded.startswith("data:image/jpeg;base64,"):
                return error("VALIDATION_ERROR", "Only JPEG is supported", 400)
            encoded = encoded.split(",", 1)[1]
        try:
            image_bytes = base64.b64decode(encoded, validate=True)
            with Image.open(io.BytesIO(image_bytes)) as header:
                width, height = header.size
                if header.format != "JPEG" or width > 2048 or height > 2048:
                    return error("VALIDATION_ERROR", "JPEG dimensions must not exceed 2048x2048", 400)
            image = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                return error("VALIDATION_ERROR", "Image cannot be decoded", 400)
        except (ValueError, binascii.Error, UnidentifiedImageError, OSError, cv2.error, Image.DecompressionBombError):
            return error("VALIDATION_ERROR", "Invalid JPEG image", 400)
        if model is None:
            return error(unavailable_code or "AI_UNAVAILABLE", "Model is not ready; sensor rules remain authoritative", 503)
        if not inference_lock.acquire(blocking=False):
            return error("AI_BUSY", "Inference is busy; retry later", 503)
        started = time.perf_counter()
        try:
            result = model(image, conf=threshold, verbose=False)[0]
            detections = []
            for box in result.boxes:
                cls_id = int(box.cls[0])
                label = names.get(cls_id)
                if label not in ("fire", "smoke"):
                    continue
                score = float(box.conf[0])
                if not math.isfinite(score) or not 0 <= score <= 1:
                    raise ValueError("Invalid model score")
                if score < threshold:
                    continue
                coordinates = [float(value) for value in box.xyxy[0]]
                if len(coordinates) != 4 or not all(math.isfinite(value) for value in coordinates):
                    raise ValueError("Invalid model bounding box")
                x1, y1, x2, y2 = coordinates
                if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                    raise ValueError("Out-of-frame model bounding box")
                detections.append({"classId": cls_id, "label": label, "score": score, "bbox": coordinates})
            if (clock() - captured) * 1000 >= max_age_ms:
                return error("STALE_RESULT", "Inference completed after the frame freshness limit", 503)
            score = max((item["score"] for item in detections), default=0.0)
            return jsonify(success=True, available=True, hasFire=bool(detections), confidence=round(score * 100, 1),
                           decision="risk_detected" if detections else "no_detection", detections=detections,
                           frameId=frame_id, capturedAt=datetime.fromtimestamp(captured, timezone.utc).isoformat(),
                           completedAt=datetime.fromtimestamp(clock(), timezone.utc).isoformat(), requestId=str(uuid4()),
                           imageSize={"width": width, "height": height}, latencyMs=round((time.perf_counter() - started) * 1000, 2),
                           model=metadata, advisoryOnly=True, fallback={"mode": "sensor_rules", "affectsHardware": False})
        except Exception as exc:
            app.logger.error("AI inference failed: %s", type(exc).__name__)
            return error("AI_ERROR", "Inference failed", 500)
        finally:
            inference_lock.release()

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=5000, debug=False)
