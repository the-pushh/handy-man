# HandyMan — voice-first AR repair assistant

Point at an appliance (geyser, washing machine, switchboard…), describe the
issue by voice, get probable causes with highlighted components and spoken
step-by-step guidance.

## Stack (all local-first; Modal is parked)

- Frontend: Next.js + TypeScript in `frontend/` (port 3000, proxies `/api/*` to FastAPI).
- Backend: FastAPI in `backend/server.py` (port 8000): staged SSE pipeline
  (`backend/pipeline.py`), language detect (`backend/lang.py`), narration
  templates (`backend/voice_lines.py`), local TTS (`backend/tts_local.py`).

| Role | Model | Where |
|---|---|---|
| Speech-to-text | muse voice transcribe | Browser speech recognition now, `/api/transcribe` hook for server-side |
| Language detect | lexicons + script + langdetect → MMS codes | `backend/lang.py` — Hinglish/code-mix first, 6 anchored languages, CJK split, 55 statistical |
| Narration translate | nllb-200-distilled (cached) | `backend/i18n.py` + `backend/voice_lines_i18n.json` — every NLLB-covered voice |
| Object detection | sam3.1 | Staged proposals in `backend/pipeline.py` + tap-to-tag in UI |
| On-device reasoning | muse glimmer | Heuristic in `backend/voice_lines.py` (no public weights exist) |
| Overlay generation | muse image | Real spliced evidence crops + vector highlights |
| TTS | mms-tts, all 999 voices | Lazy local checkpoints in the transcript's own language (`backend/mms_languages.json`) |

## Languages

- Voice: all 999 MMS-TTS checkpoints, downloaded lazily on first use
  (`/api/languages` lists them; the UI has an Auto-detect + picker).
- Narration: authored English/Hindi/Hinglish, NLLB-translated for every
  other voice NLLB covers, cached in `backend/voice_lines_i18n.json`.
- Honest gaps: some languages have no MMS voice at all (verified absent:
  Mandarin, Japanese, Italian, Norwegian) — those reply in English with
  the recognizer still set to your language. Symptom matching runs
  against a reverse translation so it works in any narrated language.
- First use of a new narration language downloads the NLLB model once
  (~2.5GB) and is slow; every later turn is instant.

### Widely-spoken language coverage

| Language | Voice | Narration |
|---|---|---|
| English, Hindi, Hinglish | local MMS | authored (no translation needed) |
| Spanish, German, French, Portuguese, Dutch, Catalan, Korean, Marathi, Bengali, Tamil, Telugu, Urdu, Arabic, Persian, Russian, Polish, Ukrainian, Vietnamese, Thai, Indonesian, Swahili, Gujarati, Punjabi, Hebrew, Greek, Romanian, Hungarian, Finnish, Swedish | local MMS | NLLB-translated, cached |
| Mandarin, Japanese, Italian, Norwegian, Turkish, Czech, Danish, Standard Malay | — (no MMS checkpoint exists) | replies simply in English |

<details>
<summary>All 107 translated-narration languages</summary>

- Achinese (`ace`)
- Akan (`aka`)
- Amharic (`amh`)
- Arabic (`ara`)
- Assamese (`asm`)
- Awadhi (`awa`)
- Central Aymara (`ayr`)
- South Azerbaijani (`azb`)
- North Azerbaijani (`azj-script_cyrillic`)
- North Azerbaijani (`azj-script_latin`)
- Bashkir (`bak`)
- Bambara (`bam`)
- Balinese (`ban`)
- Bemba (Zambia) (`bem`)
- Bengali (`ben`)
- Tibetan (`bod`)
- Bulgarian (`bul`)
- Catalan (`cat`)
- Welsh (`cym`)
- German (`deu`)
- Southwestern Dinka (`dik`)
- Dyula (`dyu`)
- Dzongkha (`dzo`)
- Modern Greek (1453-) (`ell`)
- English (`eng`)
- Basque (`eus`)
- Ewe (`ewe`)
- Faroese (`fao`)
- Persian (`fas`)
- Fijian (`fij`)
- Finnish (`fin`)
- Fon (`fon`)
- French (`fra`)
- Guarani (`grn`)
- Gujarati (`guj`)
- Haitian (`hat`)
- Hausa (`hau`)
- Hebrew (`heb`)
- Hindi (`hin`)
- Chhattisgarhi (`hne`)
- Hungarian (`hun`)
- Iloko (`ilo`)
- Indonesian (`ind`)
- Icelandic (`isl`)
- Javanese (`jav`)
- Kabyle (`kab`)
- Kachin (`kac`)
- Kannada (`kan`)
- Kazakh (`kaz`)
- Kabiyè (`kbp`)
- Khmer (`khm`)
- Kikuyu (`kik`)
- Kinyarwanda (`kin`)
- Kirghiz (`kir`)
- Northern Kurdish (`kmr-script_arabic`)
- Northern Kurdish (`kmr-script_cyrillic`)
- Northern Kurdish (`kmr-script_latin`)
- Korean (`kor`)
- Lao (`lao`)
- Ganda (`lug`)
- Maithili (`mai`)
- Malayalam (`mal`)
- Marathi (`mar`)
- Minangkabau (`min`)
- Dutch (`nld`)
- Nuer (`nus`)
- Chichewa (`nya`)
- Odia (`ory`)
- Pangasinan (`pag`)
- Panjabi (`pan`)
- Papiamento (`pap`)
- Polish (`pol`)
- Portuguese (`por`)
- Ayacucho Quechua (`quy`)
- Romanian (`ron`)
- Rundi (`run`)
- Russian (`rus`)
- Sango (`sag`)
- Shan (`shn`)
- Samoan (`smo`)
- Shona (`sna`)
- Somali (`som`)
- Spanish (`spa`)
- Sundanese (`sun`)
- Swedish (`swe`)
- Swahili (individual language) (`swh`)
- Tamil (`tam`)
- Tamasheq (`taq`)
- Tatar (`tat`)
- Telugu (`tel`)
- Tajik (`tgk`)
- Tagalog (`tgl`)
- Thai (`tha`)
- Tigrinya (`tir`)
- Tok Pisin (`tpi`)
- Tsonga (`tso`)
- Turkmen (`tuk-script_arabic`)
- Turkmen (`tuk-script_latin`)
- Uighur (`uig-script_arabic`)
- Uighur (`uig-script_cyrillic`)
- Ukrainian (`ukr`)
- Urdu (`urd-script_arabic`)
- Urdu (`urd-script_devanagari`)
- Urdu (`urd-script_latin`)
- Vietnamese (`vie`)
- Waray (Philippines) (`war`)
- Yoruba (`yor`)

</details>

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

## Photo repair (real intelligence + highlights)

The "Repair a photo" view in the app, `POST /api/repair/analyze` (+
`/api/repair/highlight` per step) on the backend: upload a photo and
describe the issue. Muse Spark (`muse-spark-1.3-contributor`) identifies
the appliance, brand/model, and parts; a second call diagnoses causes,
safety warnings, and ordered check/how steps; Muse Image (`muse-image-1.0`)
highlights each step's part with an IKEA-style A/B/C legend while the
MMS voice talks you through it — one step at a time with Next/Back,
plus embedded tutorial videos, reference-picture links, and a closing
resolution check. Needs `MUSE_SPARK_API_URL` + `MUSE_SPARK_API_KEY` in
`.env` (see `.env.example`). Hosted `sam-3.1` masks stay a hook point
until its dashboard request format lands.

## Flow (voice is the only trigger)

Tap Talk and speak — the system takes it from there: it captures a still
itself, detects your language (English, Hindi, Hinglish/code-mix), and
streams its thinking aloud while overlays land simultaneously — finding
the device, checking regional variants, searching the logo, marking
components, pinpointing the problem area. Each inference shows the spliced
image portion it came from. Then spoken repair steps with highlights.
Saying "next" (or अगला) advances a step. Tapping the still tags a part
the detector missed. The video stream is never recorded — only
system-captured stills.
