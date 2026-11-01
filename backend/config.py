"""Backend settings, read once from the environment and checked at startup.

Every variable is documented in backend/.env.example. `validate()` runs
when the server starts and stops it with a message naming each missing or
bad variable, instead of failing later on a user's first turn.

HANDYMAN_ENV=production (set by the Cloud Run deploy) makes the proxy
secret and allowed origin required and SPARK_MODEL=prod mandatory.
"""

import os
import sys

PRODUCTION = os.environ.get("HANDYMAN_ENV", "").strip().lower() == "production"


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"[config] {name} must be a whole number, got {raw!r}.")
    if value < 0:
        raise SystemExit(f"[config] {name} must be 0 or more, got {value}.")
    return value


def _list(name: str) -> list:
    return [x.strip().rstrip("/") for x in os.environ.get(name, "").split(",")
            if x.strip()]


# Shared secret the Vercel middleware adds to every proxied /api request
# (x-handyman-proxy). Required in production; when set, requests without
# it get 403, so the Cloud Run URL cannot be used to skip the rate limits.
PROXY_SECRET = os.environ.get("PROXY_SECRET", "").strip()
# Browser origins allowed by CORS. Production traffic is same-origin
# through the Vercel proxy, so this only matters for direct calls.
ALLOWED_ORIGINS = _list("ALLOWED_ORIGINS")

# Per-IP limits (rolling hour / day). 0 disables a limit.
RATE_TURNS_PER_HOUR = _int("RATE_TURNS_PER_HOUR", 20)
RATE_REQUESTS_PER_HOUR = _int("RATE_REQUESTS_PER_HOUR", 800)
PLACES_PER_SESSION = _int("PLACES_PER_SESSION", 3)
PLACES_PER_IP_PER_DAY = _int("PLACES_PER_IP_PER_DAY", 15)


def validate() -> None:
    """Fail fast with every problem listed, before serving anything."""
    problems = []
    for name, why in [
        ("MUSE_SPARK_API_URL", "Meta Model API gateway URL"),
        ("MUSE_SPARK_API_KEY", "Meta Model API key"),
    ]:
        if not os.environ.get(name, "").strip():
            problems.append(f"{name} is missing ({why}).")
    url = os.environ.get("MUSE_SPARK_API_URL", "").strip()
    if url and not url.startswith("https://"):
        problems.append("MUSE_SPARK_API_URL must start with https://.")
    if PRODUCTION:
        if not PROXY_SECRET:
            problems.append("PROXY_SECRET is missing (required when "
                            "HANDYMAN_ENV=production).")
        elif len(PROXY_SECRET) < 32:
            problems.append("PROXY_SECRET must be at least 32 characters.")
        if not ALLOWED_ORIGINS:
            problems.append("ALLOWED_ORIGINS is missing (your Vercel URL, "
                            "required when HANDYMAN_ENV=production).")
        model = os.environ.get("SPARK_MODEL", "").strip().lower()
        if model != "prod":
            problems.append(f"SPARK_MODEL must be 'prod' in production, got "
                            f"{model or 'nothing'!r}.")
    if not os.environ.get("GOOGLE_PLACES_API_KEY", "").strip():
        print("[config] GOOGLE_PLACES_API_KEY is not set: 'call a pro' will "
              "show no nearby listings.", file=sys.stderr)
    if problems:
        raise SystemExit("[config] Cannot start:\n  - " + "\n  - ".join(problems))
