# What comes next

Ordered by what would help an owner most, based on what testing showed.

## Faster camera search

Each camera check takes 4–12 s: Muse Spark has to name the machine before
SAM 3.1 can outline it, and Spark's time varies run to run. Next:

- Start SAM on the item from the owner's words ("AC" → "air conditioner")
  at the same time as Spark, so the outline doesn't wait for Spark's
  answer; Spark still decides whether it's the right item and well framed.
- Track the outline between checks on the phone (cheap frame-to-frame
  tracking), so it follows the machine as the owner moves instead of
  clearing.
- Stream the answer: show the name and framing hint as soon as Spark
  answers, the outline when SAM does.

## Speech in more languages

- Speech recognition in Hindi (`hi-IN`) when the owner starts in Hindi or
  Hinglish, instead of English only.
- Ask Muse Spark to reply in the owner's language, and speak it with the
  matching MMS voice (MMS-TTS has voices for over a thousand languages;
  we ship English and Hindi).
- Hands-free steps: "next", "back", "done" by voice.

## Better highlights

- On the inverter, SAM sometimes finds nothing for parts named the trade
  way ("display", "LED"); plain visual words work better ("black panel",
  "green light"). Learn the phrase that works per part from past runs.
- Ask for a closer photo when a step's part is not in the picture (the
  battery top for a float check), the same way the camera search asks.

## Reruns that learn

- Today a rerun tells the model what was tried and what's still wrong.
  Next: keep the after photo of each run and compare across runs, and
  stop early when two runs in a row find the same thing.

## Technicians

- Let the owner pick which technician to send the description to and
  remember who fixed it, in History.
- Opening hours and "call now" ordering by who is open.

## Accounts and sync

History lives on the phone only, by design. An optional sign-in would let
a family share one house's history (the AC's runs, the inverter's
service dates) across phones.

## Evaluation

- More demo cases with photos (scooter, laptop) in `eval/specs.json`.
- Run the eval nightly against the live models and track pass rate and
  latency per step.
