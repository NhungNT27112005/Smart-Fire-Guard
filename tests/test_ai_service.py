"""Flask HTTP contract tests with a stub model, without loading best.pt."""
import base64
import importlib.util
import io
from pathlib import Path
import unittest
from types import SimpleNamespace

from PIL import Image

spec = importlib.util.spec_from_file_location("fireguard_ai", Path(__file__).resolve().parents[1] / "ai" / "ai_service.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Model:
    names = {0: "fire", 1: "smoke", 2: "person"}

    def __call__(self, image, **kwargs):
        return [SimpleNamespace(boxes=[SimpleNamespace(cls=[0], conf=[0.8], xyxy=[[0, 0, 7, 7]])])]


def jpeg(width=8, height=8):
    stream = io.BytesIO()
    Image.new("RGB", (width, height)).save(stream, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(stream.getvalue()).decode("ascii")


class AiContractTests(unittest.TestCase):
    def setUp(self):
        self.client = module.create_app(Model()).test_client()

    def test_valid_jpeg_inference_contract(self):
        response = self.client.post("/detect", json={"image": jpeg()})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["hasFire"])
        self.assertEqual(response.json["confidence"], 80.0)
        self.assertTrue(response.json["advisoryOnly"])
        self.assertEqual(response.json["model"]["validationStatus"], "test_double")
        self.assertEqual(response.json["detections"][0]["label"], "fire")

    def test_invalid_payloads_are_client_errors(self):
        for payload in [None, [], {}, {"image": 1}, {"image": "###"}, {"image": ""}, {"image": jpeg(), "extra": 1}, {"image": "data:image/png;base64,YQ=="}]:
            with self.subTest(payload_type=type(payload).__name__):
                self.assertEqual(self.client.post("/detect", json=payload).status_code, 400)

    def test_dimensions_and_body_limit(self):
        self.assertEqual(self.client.post("/detect", json={"image": jpeg(2049, 1)}).status_code, 400)
        self.assertEqual(self.client.post("/detect", json={"image": "A" * (513 * 1024)}).status_code, 413)

    def test_health_and_unknown_route(self):
        self.assertTrue(self.client.get("/health").json["modelReady"])
        self.assertEqual(self.client.get("/missing").status_code, 404)

    def test_stale_input_and_stale_result_are_unknown(self):
        from datetime import datetime, timezone
        now = [1760000000.0]
        class SlowModel(Model):
            def __call__(self, image, **kwargs):
                now[0] += 6
                return super().__call__(image, **kwargs)
        client = module.create_app(SlowModel(), clock=lambda: now[0]).test_client()
        old = datetime.fromtimestamp(now[0] - 20, timezone.utc).isoformat()
        self.assertEqual(client.post("/detect", json={"image": jpeg(), "capturedAt": old}).status_code, 422)
        response = client.post("/detect", json={"image": jpeg()})
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json["available"])
        self.assertIsNone(response.json["hasFire"])
        self.assertEqual(response.json["fallback"]["mode"], "sensor_rules")

    def test_untrusted_checkpoint_is_not_deserialized(self):
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        temp_root = Path(__file__).resolve().parents[1] / ".tmp"
        temp_root.mkdir(exist_ok=True)
        with TemporaryDirectory(prefix="fireguard-ai-test-", dir=temp_root) as directory:
            resolved = Path(directory).resolve()
            self.assertEqual(resolved.parent, temp_root.resolve())
            checkpoint = resolved / "untrusted.pt"
            checkpoint.write_bytes(b"DEMO unit fixture: never execute")
            with patch.dict("sys.modules", {"ultralytics": None}):
                client = module.create_app(settings={"model_path": str(checkpoint), "trusted_sha256": ""}).test_client()
                self.assertEqual(client.get("/health").status_code, 503)
                response = client.post("/detect", json={"image": jpeg()})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json["error"]["code"], "MODEL_NOT_TRUSTED")
                self.assertIsNone(response.json["hasFire"])

    def test_class_mismatch_and_invalid_scores_fail_closed(self):
        class WrongModel(Model):
            names = {0: "person"}
        client = module.create_app(WrongModel()).test_client()
        self.assertEqual(client.post("/detect", json={"image": jpeg()}).status_code, 503)
        class InvalidModel(Model):
            def __call__(self, image, **kwargs):
                return [SimpleNamespace(boxes=[SimpleNamespace(cls=[0], conf=[float("nan")], xyxy=[[0, 0, 7, 7]])])]
        client = module.create_app(InvalidModel()).test_client()
        with self.assertLogs(client.application.logger, level="ERROR"):
            response = client.post("/detect", json={"image": jpeg()})
        self.assertEqual(response.status_code, 500)
        self.assertIsNone(response.json["hasFire"])

    def test_restricted_mode_uses_only_the_restricted_loader(self):
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        temp_root = Path(__file__).resolve().parents[1] / ".tmp"
        temp_root.mkdir(exist_ok=True)
        with TemporaryDirectory(prefix="restricted-ai-", dir=temp_root) as directory:
            checkpoint = Path(directory) / "fixture.pt"
            checkpoint.write_bytes(b"DEMO test fixture, not a trained model")
            settings = {"model_path": str(checkpoint), "load_mode": "restricted"}
            with patch.object(module, "load_restricted_model", return_value=Model()) as loader:
                response = module.create_app(settings=settings).test_client().get("/health")
                loader.assert_called_once_with(checkpoint)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json["model"]["loadingMode"], "restricted")
                self.assertFalse(response.json["model"]["provenanceVerified"])
                self.assertEqual(response.json["model"]["validationStatus"], "unvalidated_candidate")
            with patch.object(module, "load_restricted_model", side_effect=module.RestrictedLoaderUnavailable):
                response = module.create_app(settings=settings).test_client().get("/health")
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json["reason"], "RESTRICTED_LOADER_UNAVAILABLE")

    def test_restricted_mode_never_downgrades_on_unsupported_libraries(self):
        from unittest.mock import Mock, patch
        yolo = Mock()
        tasks = SimpleNamespace(_SafeLoad=SimpleNamespace(SUPPORTED=False), SAFE_LOAD=True)
        with patch.dict("os.environ"), patch.dict("sys.modules", {
            "ultralytics": SimpleNamespace(YOLO=yolo),
            "ultralytics.nn": SimpleNamespace(tasks=tasks)
        }):
            with self.assertRaises(module.RestrictedLoaderUnavailable):
                module.load_restricted_model(Path("DEMO_fixture.pt"))
            yolo.assert_not_called()

    def test_no_detection_is_not_a_safety_certification(self):
        class EmptyModel(Model):
            def __call__(self, image, **kwargs):
                return [SimpleNamespace(boxes=[])]
        response = module.create_app(EmptyModel()).test_client().post("/detect", json={"image": jpeg()})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json["hasFire"])
        self.assertEqual(response.json["decision"], "no_detection")
        self.assertFalse(response.json["model"]["confidenceIsCalibratedProbability"])
        self.assertFalse(response.json["fallback"]["affectsHardware"])


if __name__ == "__main__":
    unittest.main()
