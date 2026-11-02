# Handyman

Fix what you can. Call for what you can't.

**Live:** https://handyman.thepushh.com (free, no login, made for phones)

Tell your phone what's broken. Meta's models find the machine in your
camera, work out what's wrong and decide, with a safety-rules layer,
whether you can fix it yourself. If you can, it talks you through the fix
step by step, highlighting each part on the photo, and checks the result
with the camera. If you can't, it says why and lists nearby technicians
with phone numbers and a ready-to-send description of the problem.

## How a fix goes

1. **Say what's wrong, and be specific.** Tap the button and speak (or
   type) the machine and what it does or doesn't do: "my AC runs but the
   air isn't cold", "laptop won't turn on, the charger light is off".
   Avoid "it's broken" or "not working": they name no symptom. The app
   asks once for more when it hears one of those; a second try goes
   ahead anyway.
2. **The camera finds it.** The app looks for the machine you named in the
   live camera and outlines it on the stream.
3. **It frames the picture with you.** If the machine isn't in view, is
   too far or is cut off, it says so ("Come closer to the air
   conditioner") and checks again when you hold still. When the framing
   is good it takes the picture itself. "Use this view" skips ahead.
4. **Quick checks first (phase 0).** Most machines reported broken have a
   trivial cause the owner missed, so before any diagnosis the app lists
   the 2–4 things to rule out first on that kind of machine for that
   problem (its own system prompt, `QUICK_CHECKS_SYSTEM` in
   `backend/spark.py`) (laptop: charger in and
   its light on, hold power 10 s, unplug USB devices), screened by the
   safety rules. "That fixed it" closes the job; "Still not working"
   goes on, and the diagnosis has been running in the background.
5. **The fix (phase 1).** The picture opens large; the app asks at most one or two
   look-only questions, gives its verdict, then speaks each step while
   highlighting the part it is talking about. The model decides how many
   steps.
6. **"Is it fixed now?"** After the last step it takes an after photo,
   compares it with the before photo, and asks.
7. **Still broken? (phase 2)** It asks what's still wrong and runs once
   more with that, without repeating a fix already tried. After that
   second try, or as soon as the model or the rules say a technician is
   needed, it shows nearby technicians.
8. **DIY or pro.** Easy fixes are walked through. When a fix needs a
   technician (opening a scooter's panel, refrigerant, wiring), the
   verdict names the safety rule, keeps the look-only checks and shows
   who to call.
9. **Warning before you start.** For machines an owner shouldn't open
   (microwave, gas appliance, geyser, switchboard or wiring, EV battery,
   TV) or a danger sign (smoke, sparks, a swollen battery), the app warns
   right after the scan. You can call a technician, or tick "I understand
   the risk" and go on at your own risk; that run is labelled as such.
10. **History.** Every run is kept on the phone, grouped by machine, with
   each attempt listed under it (photos, steps, verdict, outcome).

While a model works, the screen says what is happening, who is doing it
and for how long ("Looking for the air conditioner… 4s · Muse Spark looks,
SAM 3.1 outlines").

## Which model runs where

All calls are live; there are no canned answers.

| Screen | What happens | Model | Code |
|---|---|---|---|
| Camera search | Find the machine you named, judge the framing | `muse-spark-1.3` | `backend/spark.py` `spot()` |
| Camera search | Outline the machine on the live stream | `sam-3.1` | `backend/sam31.py` `find_object()` |
| Camera search | Warn before diagnosis | rules (no model) | `backend/risk.py` `scan_check()` |
| Listening (beeps) | Count and time beeps; cross-check by ear | measured audio features + `muse-wonder-1.0` | `backend/audiofeat.py`, `backend/wonder.py` |
| Walkthrough | Read the photo, diagnose, ask questions, decide | `muse-spark-1.3` | `backend/spark.py` |
| Walkthrough | Decide what an owner may do | rules (no model) | `backend/risk.py` `judge()` |
| Walkthrough | Outline each step's part | `sam-3.1`; `muse-image-1.0` (labelled illustrative) when SAM finds nothing | `backend/sam31.py`, `backend/muse_image.py` |
| Final check | Compare before and after photos | `muse-spark-1.3` | `backend/spark.py` `recheck()` |
| Speech | Speak every line | MMS-TTS (Meta), English and Hindi voices, on our server | `backend/tts_local.py` |
| Speech-to-text | What you say | the browser's speech recognition | `frontend/app/page.tsx` |
| Technicians | Nearby listings with phone numbers | Google Places API (New); a Google Maps search button without it | `backend/places.py`, `frontend/app/components/CallAPro.tsx` |

Local development uses `muse-spark-1.3-contributor` (`SPARK_MODEL=local`);
production always runs `muse-spark-1.3`.

## The safety rules

The model proposes; `backend/risk.py` decides. It reads every proposed
step and the reported symptoms and blocks what an owner shouldn't do:
mains wiring, gas fittings, battery terminals, sealed casings, a
scooter's body panels, an AC's sealed refrigerant system, and any step
that is itself "get a professional". Owner jobs are allowed explicitly
(an AC's front panel and filter, an inverter battery's floats and
distilled water, a laptop's base cover for RAM or SSD). The verdict card
names the rule that fired. `python backend/test_risk.py` runs its 34
tests.

## Languages

- Speech recognition is the browser's, in English (`en-US`). The app
  detects Hindi and Hinglish in what was said (`/api/detect-language`)
  to pick the voice.
- The model replies in English. Lines in Hindi script are spoken with the
  Hindi MMS voice; everything in Latin letters (English, Hinglish typed in
  English letters) with the English voice.
- Other languages are not supported in this build.

## Run locally

```
make            # setup + backend on :8000 + frontend on :3000
```

Open http://127.0.0.1:3000 (camera and mic need localhost or HTTPS).
Needs `MUSE_SPARK_API_URL` and `MUSE_SPARK_API_KEY` in `.env` at the repo
root; every variable is documented in `backend/.env.example` and
`frontend/.env.example`.

```
make setup      # dependencies only (venv + pip + npm)
make backend    # FastAPI alone
make frontend   # Next.js alone
make phone      # backend + frontend + a cloudflared tunnel for a real phone
make container  # the backend as a local Docker container (uses .env)
make deploy     # modal deploy backend/modal_app.py
```

## Tests and eval

```
python backend/test_risk.py        # safety rules
python backend/test_audiofeat.py   # beep measurement
python backend/test_limits.py      # rate limits
python backend/test_guard.py       # proxy secret, limits, voice choice
SPARK_MODEL=prod python -m eval.run      # demo cases, live models
SPARK_MODEL=prod python -m eval.breadth  # 21 everyday cases beyond the demo
```

`eval/breadth.py` checks the app holds beyond the three demo machines:
washing machine, fridge, fan, TV, router, printer, phone charger, mixer,
water purifier, car, bicycle, lamp, the hazards (geyser, gas stove,
microwave, a sparking socket, an e-scooter battery, smoke), Hinglish and
vague input. For each it runs the scan warning, the quick checks and the
diagnosis through the safety rules, and checks that hazards warn and
everyday machines don't, that quick checks are safe, that the verdict and
the finding agree, and that the trade fits the machine. Latest run: 21 of
21.

`eval/run.py` sends each case in `eval/specs.json` through the real
backend (camera search, diagnosis, answers) and prints a pass/fail table.
The photos are from a private home and are not in the repo; put your own
in `eval/cases/` with the names in `specs.json`. A case without its photo
is reported as SKIP. Latest run (2026-11-02, `muse-spark-1.3`):

| Case | What it checks | Result |
|---|---|---|
| ac-not-cooling | finds the AC, framed, no warning, DIY, "clogged filter", 3 steps | PASS |
| inverter-beeping | finds the inverter, 3 measured beeps, DIY, "low battery water", 4 steps | PASS |
| inverter-back-not-charging | finds the inverter from the back, analysis runs, 4 steps | PASS |
| scooter-self-start | pro verdict, rule `vehicle-body-panel` | SKIP (no photo yet) |
| wrong-item-in-view | asked for the AC, inverter in view: not ready | PASS |
| scan-warning-microwave | "microwave": warning before diagnosis | PASS |
| danger-symptom-smoke | "smoke": danger warning on any machine | PASS |

6 passed, 0 failed, 1 skipped.

`.github/workflows/checks.yml` runs ruff, the four test files and the
frontend type check when started by hand from the Actions tab (not on
every push). It deploys nothing.

## Deploy

Backend on [Modal](https://modal.com), frontend on Vercel. No database.

- **Backend:** `modal deploy backend/modal_app.py`. It builds the image
  from `backend/requirements.txt` (CPU-only torch, both MMS voices baked
  in), serves the FastAPI app with `@modal.asgi_app`, and speaks one
  warm-up line before a container takes traffic. Sizing (2 cores, 3 GB,
  one warm container, at most 3) is one block at the top of that file.
  It sets `SPARK_MODEL=prod` and `HANDYMAN_ENV=production` itself.
- **Secrets:** one Modal secret named `handy-man` with
  `MUSE_SPARK_API_URL`, `MUSE_SPARK_API_KEY`, `PROXY_SECRET`,
  `ALLOWED_ORIGINS` and, optionally, `GOOGLE_PLACES_API_KEY`. The backend
  refuses to start, naming each missing key. A running container keeps
  the secret it started with: redeploy after changing it. Vercel holds
  `BACKEND_URL` and the same `PROXY_SECRET`.
- **Frontend:** Vercel builds `frontend/`. The browser only talks to the
  Vercel domain; `frontend/middleware.ts` forwards `/api/*` to Modal with
  the proxy secret, and the backend rejects calls without it.
- **Protecting the bill:** per-IP limits on fixes and requests, a cap on
  technician searches per session and per IP per day, at most 3 Modal
  containers, and one JSON usage line per request in the Modal logs
  (`"kind": "usage"`).
- **Privacy:** history stays in the browser (localStorage for the facts,
  IndexedDB for small photos and the sound clip, last 20 runs). Nothing
  is stored on the server. Location goes in a request body, never in a
  URL, and only when the technician list opens.
- **Unused:** `infra/setup.sh` (an earlier Google Cloud Run setup) is kept
  for reference only. `backend/Dockerfile` is for running locally.

## Built during the hackathon (Oct 26 to Nov 4)

Everything in this repository was written during the event: the first
commit is on 2026-10-30, and every commit since is in `git log`. No code,
data or assets from before the event; the demo photos are our own and
are not committed. Third-party pieces are open-source libraries (Next.js,
FastAPI, PyTorch, transformers) and hosted APIs (Meta's Model API, Google
Places), used through their public interfaces.

See [FUTURE.md](FUTURE.md) for what comes next.
