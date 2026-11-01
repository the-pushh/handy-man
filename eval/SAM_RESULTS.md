# SAM 3.1 on real device photos

Run 2026-11-01 against the live `sam-3.1` API on the 768px q70 stills the
app sends, with `muse-spark-1.3` for perception and the box fallback.
Reproduce with:

    SPARK_MODEL=prod .venv/bin/python -m eval.sam_table --all
    SPARK_MODEL=prod .venv/bin/python -m eval.sam_table eval/cases/<photo> "phrase" "phrase" --no-box

The photos are from a private home and are not in the repo (one shows a
phone number); drop your own into `eval/cases/` named by part
(`ac_front_1.jpg`, `inverter_back_1.jpg`, ...). Overlays land in
`eval/out/` (also not committed).

`top c` is SAM's highest confidence for the phrase. "On target" was
checked by eye on the overlays, because confidence alone does not say
whether a mask is on the right thing.

## 1. Requested phrases (trade names)

| Photo | Phrase | Tried as | Matches | Top c | On target |
|---|---|---|---|---|---|
| ac_front | air conditioner | phrase | 1 | 0.94 | yes |
| ac_front | front panel | phrase, "panel", "front" | 0 | - | - |
| ac_front | front panel | Spark box prompt | 1 | 0.67 | no, speckled |
| ac_front | vent | phrase | 0 | - | - |
| ac_front | vent | Spark box prompt | 1 | 0.87 | yes (outlet slot) |
| ac_front | display | phrase; Spark: not visible | 0 | - | - |
| inverter_front | inverter | phrase | 0 | - | - |
| inverter_front | inverter | Spark box prompt | 1 | 0.91 | no, includes boxes on top |
| inverter_front | display | Spark box prompt | 1 | 0.82 | no, table edge |
| inverter_front | LED | Spark box prompt | 1 | 0.57 | no |
| inverter_front | switch | Spark box prompt | 1 | 0.83 | no |
| inverter_front | socket | phrase; Spark: not visible | 0 | - | - |
| inverter_front | power cable | "cable" | 3 | 0.92 | yes |
| inverter_back | inverter | Spark box prompt | 1 | 0.75 | no |
| inverter_back | display | Spark box prompt | 1 | 0.61 | no, cardboard box |
| inverter_back | LED | Spark box prompt | 1 | 0.83 | no |
| inverter_back | switch | phrase | 3 | 0.73 | yes (red rocker) |
| inverter_back | socket | Spark box prompt | 1 | 0.44 | no |
| inverter_back | power cable | "cable" | 3 | 0.96 | yes |

Box prompts built from Spark's pixel boxes: 1 of 10 on target, at
0.44-0.91 confidence. SAM fills whatever box it is given, and Spark's
boxes are off. Not used in the app.

## 2. Plain-appearance phrases

| Photo | Part | Phrase | Matches | Top c | On target |
|---|---|---|---|---|---|
| ac_front | air conditioner | split ac | 1 | 0.82 | yes |
| ac_front | logo | logo | 2 | 0.75 | yes |
| ac_front | power cable | cable / black wire | 1 | 0.96 | yes |
| ac_front | switch box (MCB) | grey box / electrical box | 1 | 0.61-0.83 | yes |
| ac_front | switch box | "wall" (cut from "wall switch") | 2 | 0.93 | no, the wall |
| inverter_front | display | black panel | 2 | 0.81 | yes |
| inverter_front | LED | green light | 1 | 0.82 | yes |
| inverter_front | red cable | red cable | 1 | 0.95 | yes |
| inverter_front | tape | yellow tape | 3 | 0.96 | yes |
| inverter_front | inverter body | white box / device | 0 | - | - |
| inverter_front | "electrical box" | "box" | 3 | 0.90 | no, cardboard boxes |
| inverter_back | inverter body | device | 1 | 0.75 | yes |
| inverter_back | fan | round vent / cooling fan / vent | 1 | 0.68-0.96 | yes |
| inverter_back | switch | red switch | 3 | 0.70 | yes |
| inverter_back | wires | yellow wire / black wire | 1-2 | 0.96 | yes |
| inverter_back | fan | fan / fan grill | 0 | - | - |
| inverter_back | terminal | terminal / red terminal | 0 | - | - |

## 3. In the app (Spark `look` phrases, part name as fallback)

Spark's perception names each part's look ("black panel", "green
light"); SAM is asked that first, then the part name. Masks keep the part
label. One pass per photo:

| Photo | Parts outlined | Masks on target | Missed |
|---|---|---|---|
| ac_front | 3 / 5 | 3 / 3 | front cover, louvre flap |
| inverter_back | 5 / 8 | 5 / 5 | knob, socket, (body on one run) |
| inverter_front | 5 / 8 | 5 / 5 | inverter body |

Segmenting all parts in parallel: 3.2-5.0 s.

Takeaways:

- SAM 3.1 finds plain visual nouns (colour or shape plus an everyday
  noun), not trade names.
- Never cut a phrase down to one generic word ("wall", "box").
- High confidence on a box prompt says nothing about whether the box was
  right.
