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

On first use a short card explains the app: tap to speak and describe
the problem, Type or Photo as the alternatives, and the safety note
(advice only, at your own risk). It shows once per browser.

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
   steps. After each step but the last it asks "Is it working now?",
   since one step is sometimes the whole fix; "Only ask me after the last
   step" turns that off. Every step's speech is fetched while the verdict
   is on screen, so a step starts talking the moment it opens.
6. **"Is it working now?"** After the last step the camera comes back
   and scans the machine again the same way as the first time (it says
   what to do, outlines it, asks you to move if needed, takes the
   picture). The after photo fills a camera-style screen with the before
   photo in the corner and the comparison along the bottom; the bar
   below has "It's working" and "Still broken".
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
10. **History.** Every run is kept, grouped by machine, with each attempt
   listed under it. Each run has its photos, its step pictures with
   highlights, verdict, outcome, the handymen found and the diagnosis to
   share.
   - **Where:** on the phone, and on the server for this browser when
     the backend has a database (no login).
   - **Deleting:** "Delete my history" removes it from both.

While the models work, the screen says what is happening and for how
long ("Looking for the air conditioner… 4s · Finding it and outlining
it"), in one voice: the app, not the model names.

## Diagnostic agent loop (on by default)

The router is on by default: clear cases
take the regular flow above, unclear ones the agent's tests. If the
loop fails mid-run, the regular flow takes over.

- **Switches:**
  - `?agent=0` (or `NEXT_PUBLIC_AGENT_LOOP=0`) keeps every case on the
    regular flow.
  - `?agent=always` sends every case to the agent.
  - A URL choice is remembered in that browser.
- **When it is used:** only for unclear cases, so a simple fix is not
  tested into doubt. The first diagnosis pass already runs during the
  quick checks, and it also says `route`.
  - **direct:** one common cause stands out (a flat laptop battery, AC
    filters not cleaned in months). The regular fix runs, with no wait.
  - **investigate:** several causes fit about equally, or the symptom is
    unusual (scooter self-start, inverter beeping, a fridge not cooling,
    "laptop not starting"). The agent's tests run first.
  - **Test (12 phrasings, two runs):** clear and unclear cases split as
    expected in both runs. "Remote dead" and "paper jam" went to
    investigate. In the app that is right: those cases reach the router
    only after the quick checks (batteries, clear the jam) failed.
- **What it does:** after the quick checks, Muse Spark keeps 3 to 4
  possible causes with probabilities and runs one test per round, the
  one that best separates the leading causes, and says why in one line:
  - **ask_user:** one question with answer chips
  - **look_closer:** the camera finds and frames one named part, like
    the first scan
  - **listen:** 4 s of sound through the existing beep measurement
  - **segment:** SAM 3.1 outlines a part on the photo
- **The board:** a live list of causes with animated confidence bars,
  the 75% line, and every test with its reason and result. Each round
  is also in the trace drawer ("Handyman agent · round N").
- **When it stops** (`backend/agent.py`):
  - **Confident:** the leading cause passes 75%. The regular diagnosis
    then turns the findings into steps.
  - **Five tests run:** it stops and does the same.
  - **Next test blocked:** the best next test is blocked by a safety rule
    (opening a scooter's panel, touching battery terminals). It escalates
    to a handyman with "Next test blocked by rule: ...".
- **Two guards on the stop rules:**
  - Owner answers are softer evidence than a photo or a measurement. On
    answers alone, the leading cause is held at 75% until three tests
    agree.
  - While the case still rests on answers, a blocked test is first
    swapped for the best safe one.
- **Speed:** one model call per round at `minimal` effort, with three
  identical requests racing and the first answer winning. Rounds take
  4 to 8 s.
- **Test:** `SPARK_MODEL=prod python -m eval.agent` runs the AC,
  inverter and scooter cases. A stand-in owner answers each test from
  the case's facts. Latest runs: all three pass twice in a row.
  - **AC:** 1 to 2 tests, filters at 82 to 85%.
  - **Inverter:** listen, then the panel lights. Battery at 80%, or it
    escalates.
  - **Scooter:** 3 to 4 tests, weak battery. The panel rule escalates it.
  - **Every round:** 4.1 to 7.8 s.
  The scooter photo is a muse-image render. Like the other photos, it
  is not committed.
- **Handyman list:** the top three are ranked by open now, distance and
  rating, with the reasons shown (`frontend/app/lib/rankPros.ts`), and
  the rest sit under "More nearby". Each listing with an international
  number gets a WhatsApp button: a wa.me link with the diagnosis card
  filled in. The owner presses send.
- **History and the learning loop** (`backend/history_store.py`,
  `backend/feedback.py`): one Postgres database (`DATABASE_URL`; Vercel
  Postgres / Neon on the deployed backend, SQLite or a local Postgres in
  tests). The tables are created on first use. Without a database both
  features are off and the app works as on `main`.
  - **History per browser:** runs and their small images, under a random
    ID kept in the browser. The server keeps up to 500 runs per browser
    (the phone keeps 20). A run or image missing on the phone is fetched
    from the server.
  - **Outcomes** (every run, both flows, words only): the route, the
    tests and answers,
    the finding, how it ended (fixed at which step, fixed by which quick
    check, still broken, handyman), the owner's "Was it …?" and the
    after-photo check.
  - **What it learns:** the model's weights don't change (the Meta API
    serves models, it does not train them). The system around the model
    learns:
    - counts of confirmed causes per machine and symptom, used once a
      cause has 3 confirmations;
    - a few recent confirmed cases, given as worked examples to the
      agent's first look and the first diagnosis pass;
    - quick checks that fixed a machine and symptom before are listed
      first.

    The trace shows when learned context was used. The safety rules
    never read this data.
  - **Misses become tests:** `python -m eval.from_feedback` exports runs
    that ended "still broken" and were then fixed another way;
    `python -m eval.suite --feedback` runs them.
  - **Turn it on:**
    1. Create the Neon database in Vercel (Storage).
    2. Put its connection string in the Modal secret as `DATABASE_URL`.

    Nothing else is needed. Recording is on by default for every run:
    - the welcome card says so;
    - History has a "Learn from how my fixes turn out" switch to turn
      it off;
    - "Delete my history" removes these rows.
- **A separate test backend:**
  `HANDYMAN_APP=handyman-agent DIAGNOSE_EFFORT=high modal deploy backend/modal_app.py`
  deploys beside production under its own URL.
  - `DIAGNOSE_EFFORT=high` makes every diagnosis more careful, at about
    6 to 8 s extra. Leave it out to keep the fast defaults.
  - `AGENT_EFFORT` sets the effort for each round (default `minimal`).
- **Model speed:** muse-spark-1.3 writes about 90 tokens a second, and at
  `low` effort it spends 1,100 to 1,900 tokens thinking. Perceive and
  diagnosis therefore run at `minimal` by default (`low` for the
  inverter's answer pass).
  - **Measured on 2026-11-03:** perceive dropped from 11 s to 6 s, and
    each diagnosis from 12 to 15 s to 6 to 8 s, with the same findings
    and steps on the demo cases.
  - **Evals at this effort:** the breadth eval passes 21 of 21 and the
    demo eval 7 of 7.
  - **Raising it per backend:** set `PERCEIVE_EFFORT` and
    `DIAGNOSE_EFFORT`.

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
python backend/test_agent.py       # agent loop rules (no model calls)
python backend/test_feedback.py    # history and learning store (SQLite; TEST_DATABASE_URL for Postgres)
python backend/test_prompts.py     # every prompt builds, with each optional part on and off
SPARK_MODEL=prod python -m eval.run      # demo cases, live models
SPARK_MODEL=prod python -m eval.breadth  # 21 everyday cases beyond the demo
SPARK_MODEL=prod python -m eval.suite    # 31 test cases for judges and users
SPARK_MODEL=prod python -m eval.stepcheck  # scan-to-check and rescans on before/after photo pairs
```

`eval/stepcheck.py` checks step scans and rescans on six before/after photo
pairs (`--make` creates them with muse-image; the AC "before" is the real demo
photo and each "after" is an edit of its own "before"):
- the AC with its panel lifted;
- a washer with its drain flap open;
- an inverter battery with its vent caps off;
- a printer with its cartridge door open;
- a laptop with its base cover off;
- a hazard photo (burnt wiring and water behind a washer).

Each step reads "not done" on the before photo and "done" on the after
photo, every view-changing step is flagged for a rescan, and the hazard
photo gets "stop, switch off". Latest run: 6 of 6. SAM found the next part
on the new photo for the AC and the washer; for the ink cartridges, floats
and RAM the app falls back to the illustrated highlight (about 20 s).

[docs/TEST_CASES.md](docs/TEST_CASES.md) lists 31 things to try (demo machines, clear
fixes, unclear cases, safety, language, edge cases) with what you should see and
the latest dry run of each through the app's own code (`eval/suite.py`).

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
- **Privacy:**
  - **Without a database:** history stays in the browser (localStorage
    for the facts, IndexedDB for small photos and the sound clip, last 20
    runs). Nothing is stored on the server.
  - **When the backend has a `DATABASE_URL`:** each browser also gets a
    random ID (no login; one browser is one user).
    Under it the server keeps that browser's runs: the History record,
    the handymen found and contacted, and the small before, after and
    step pictures and highlights. "Delete my history" in History removes
    them from the phone and the server.
  - **Learning data:** separate from History. It is recorded for every
    run unless the owner turns it off in History. It is words only: no
    photos, sound, location or IP. The welcome card says so.
  - **Location:** it goes in a request body, never in a URL, and only
    when the handyman list opens.
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
