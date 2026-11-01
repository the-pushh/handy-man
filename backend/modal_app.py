"""Handyman backend on Modal.

Deploy (from the repo root):
    modal deploy backend/modal_app.py

The URL it prints (https://<workspace>--handyman-backend-web.modal.run)
is Vercel's BACKEND_URL.

Settings come from the Modal secret "handyman" (Modal dashboard >
Secrets). Keys, all documented in backend/.env.example:
    MUSE_SPARK_API_URL     required
    MUSE_SPARK_API_KEY     required, secret
    PROXY_SECRET           required, secret (same value as Vercel's)
    ALLOWED_ORIGINS        required, your Vercel URL
    GOOGLE_PLACES_API_KEY  optional, secret (without it: "Find nearby" button)
HANDYMAN_ENV=production and SPARK_MODEL=prod are set here, not in the
secret, so the deployed app always runs the prod model. The server checks
everything at startup (backend/config.py) and refuses to start, naming
each missing key.
"""

from pathlib import Path

import modal

# ---- Sizing: change it here, then `modal deploy backend/modal_app.py` ----
CPU = 1.0               # cores reserved per container (can burst above)
MEMORY_MB = 3072        # a full turn peaks around 1.1 GB
MIN_CONTAINERS = 1      # 1 = always warm (billed while idle); 0 after judging
MAX_CONTAINERS = 3      # hard ceiling on parallel containers (the bill)
CONCURRENT_REQUESTS = 20  # requests one container serves at once
TIMEOUT_S = 300         # per request; slowest call seen is ~22s, client gives up at 60s
SCALEDOWN_S = 300       # idle seconds before an extra container stops
# --------------------------------------------------------------------------

APP_NAME = "handyman-backend"
BACKEND = Path(__file__).parent
VOICES = ("facebook/mms-tts-eng", "facebook/mms-tts-hin")


def _bake_voices() -> None:
    """Runs once at image build: puts both MMS voices into the image."""
    from transformers import AutoTokenizer, VitsModel

    for name in VOICES:
        AutoTokenizer.from_pretrained(name)
        VitsModel.from_pretrained(name)


def _requirements() -> list:
    """requirements.txt minus torch (CPU wheel installed separately) and
    modal (the container doesn't need the client)."""
    lines = (BACKEND / "requirements.txt").read_text().splitlines()
    return [ln.strip() for ln in lines
            if ln.strip() and not ln.startswith("#")
            and ln.split("==")[0].strip() not in ("torch", "modal")]


image = (
    modal.Image.debian_slim(python_version="3.14")
    .env({"HF_HOME": "/models", "HF_HUB_DISABLE_TELEMETRY": "1",
          "PYTHONUNBUFFERED": "1"})
    # CPU-only torch: the CUDA build is ~2 GB larger and unused here.
    .pip_install("torch==2.15.0", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install(*_requirements())
    .run_function(_bake_voices)
    # Production settings that must never come from the secret.
    .env({"HANDYMAN_ENV": "production", "SPARK_MODEL": "prod",
          "HF_HUB_OFFLINE": "1"})
    # The backend package. Never the local .env, tests or caches.
    .add_local_dir(BACKEND, "/root/backend", ignore=[
        ".env", ".env.*", "**/.env", "__pycache__", "**/__pycache__",
        "test_*.py", "requirements-dev.txt", "Dockerfile", "*.pyc",
    ])
)

app = modal.App(APP_NAME, image=image)


@app.cls(
    cpu=CPU,
    memory=MEMORY_MB,
    min_containers=MIN_CONTAINERS,
    max_containers=MAX_CONTAINERS,
    timeout=TIMEOUT_S,
    scaledown_window=SCALEDOWN_S,
    secrets=[modal.Secret.from_name("handyman")],
)
@modal.concurrent(max_inputs=CONCURRENT_REQUESTS)
class Web:
    @modal.enter()
    def warm(self) -> None:
        """Before the container takes traffic: check the config, load the
        English voice and speak once, so the first spoken line is fast."""
        import time

        from backend import config, tts_local

        config.validate()
        start = time.time()
        tts_local.synthesize("ready", VOICES[0])
        print(f"[modal] TTS warm in {time.time() - start:.1f}s", flush=True)

    @modal.asgi_app()
    def web(self):
        from backend.server import app as fastapi_app

        return fastapi_app
