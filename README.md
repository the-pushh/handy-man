# HandyMan — voice-first AR repair assistant

Point at an appliance (geyser, washing machine, switchboard…), describe the
issue by voice, get probable causes with highlighted components and spoken
step-by-step guidance.

## Stack

- Frontend: Next.js + TypeScript in `frontend/` (port 3000, proxies `/api/*` to FastAPI).
- Backend: FastAPI in `backend/server.py` (port 8000, pure JSON API).
- Models on Modal: `backend/modal_app.py` (`handyman-models`: Glimmer
  diagnosis/steps, mms-tts speech). CPU-only until the real weights land —
  then put `gpu="T4"` back (needs a payment method on Modal).

| Role | Model | Where |
|---|---|---|
| Speech-to-text | muse voice transcribe | Browser speech recognition now, `/api/transcribe` hook for server-side |
| Object detection | sam3.1 | `/api/detect` shell + tap-to-tag in UI |
| On-device reasoning | muse glimmer | Modal `Glimmer`, local fallback in server |
| Overlay generation | muse image | `/api/overlay` caption shell, vector highlights live |
| TTS | mms-tts | Modal `MMSTTS`, browser voice fallback |

## Run

One command does everything (setup + backend on :8000 + frontend on :3000):

```
make
```

Open http://127.0.0.1:3000 in a browser (camera/mic need localhost or
HTTPS). Ctrl-C stops both servers.

Useful extras:

```
make setup      # dependencies only (venv + pip + npm), idempotent
make backend    # FastAPI alone — HANDYMAN_MODAL=0 for local fallbacks
make frontend   # Next.js alone
make deploy     # redeploy Glimmer + mms-tts to Modal after model changes
make auth       # authenticate this machine with Modal (opens browser)
make clean      # remove frontend build output
```

## Flow

Live feed → Capture still → detect components → describe issue by voice →
Glimmer causes → pick a cause → spoken repair steps with highlights.
Saying "next" advances a step. Tapping the still tags a part the detector
missed. The video stream is never recorded — only explicit stills.
