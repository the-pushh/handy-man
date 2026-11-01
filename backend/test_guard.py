"""Proxy secret, per-IP limits and the turn limit (backend/server.py).

Run: .venv/bin/python backend/test_guard.py   (or pytest)
Needs MUSE_SPARK_API_URL/KEY set (any values) because the server
validates its config on import; no model is called.
"""
import io
import os
import sys
from pathlib import Path

os.environ.setdefault("MUSE_SPARK_API_URL", "https://example.invalid/v1")
os.environ.setdefault("MUSE_SPARK_API_KEY", "test-not-a-key")
os.environ["PROXY_SECRET"] = "s" * 40
os.environ["RATE_TURNS_PER_HOUR"] = "2"
os.environ["RATE_REQUESTS_PER_HOUR"] = "5"
os.environ["PLACES_PER_SESSION"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend import server  # noqa: E402

c = TestClient(server.app)
OK = {"x-handyman-proxy": "s" * 40}


def test_health_is_open():
    assert c.get("/api/health").status_code == 200


def test_api_needs_the_proxy_secret():
    r = c.post("/api/detect-language", json={"text": "hello"})
    assert r.status_code == 403
    r = c.post("/api/detect-language", json={"text": "hello"},
               headers={"x-handyman-proxy": "wrong"})
    assert r.status_code == 403


def test_requests_per_hour_then_slow_down():
    h = {**OK, "x-client-ip": "10.0.0.1"}
    codes = [c.post("/api/detect-language", json={"text": "hi"}, headers=h).status_code
             for _ in range(6)]
    assert codes[:5] == [200] * 5 and codes[5] == 429
    body = c.post("/api/detect-language", json={"text": "hi"}, headers=h).json()
    assert body["status"] == "rate-limited" and "try again" in body["detail"]


def test_turns_per_hour():
    h = {**OK, "x-client-ip": "10.0.0.2"}
    jpeg = io.BytesIO()
    from PIL import Image
    Image.new("RGB", (8, 8)).save(jpeg, "JPEG")

    def first_look():
        return c.post("/api/repair/analyze", headers=h,
                      files={"file": ("f.jpg", jpeg.getvalue(), "image/jpeg")},
                      data={"components": "fan"})  # components: no Spark call

    assert first_look().status_code == 200
    assert first_look().status_code == 200
    r = first_look()
    assert r.status_code == 429 and r.json()["status"] == "rate-limited"


def test_places_capped_per_session():
    h = {**OK, "x-client-ip": "10.0.0.3", "x-session": "abc"}
    body = {"trade": "electrician", "lat": 19.0, "lng": 72.8}
    first = c.post("/api/pros", json=body, headers=h)
    assert first.status_code == 200  # needs-places-key without a key: still counted
    assert c.post("/api/pros", json=body, headers=h).status_code == 429


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"\n{len(tests)} passed")
