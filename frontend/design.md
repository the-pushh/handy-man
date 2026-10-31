---
version: alpha
name: HandyMan Drawing Sheet
description: Design system for HandyMan, a phone-first web app that turns your camera into a live, talking repair manual. Cream line work on warm charcoal drafting paper, boxed typewriter labels, and one safety-orange mark for the part being discussed.
colors:
  paper-deep: "#24292D"
  paper: "#2C3236"
  paper-raised: "#343B3F"
  grid: "#363D41"
  grid-major: "#434B50"
  line: "#EAE2C6"
  line-muted: "#A8A491"
  line-faint: "#6E6E64"
  on-line: "#24292D"
  primary: "#FF6A1A"
  primary-deep: "#C2440A"
  primary-container: "#45301F"
  on-primary: "#1A0A02"
  success: "#8FD49A"
  success-container: "#2C4234"
  warning: "#F2C94C"
  warning-container: "#433D2A"
  error: "#FF5A4A"
  error-container: "#43292A"
  info: "#A9C6D0"
  info-container: "#2E3D44"
  scrim: "#000000"
typography:
  display:
    fontFamily: Courier Prime
    fontSize: 34px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -0.01em
  headline:
    fontFamily: Courier Prime
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.15
  title:
    fontFamily: Courier Prime
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.25
  instruction:
    fontFamily: Space Grotesk
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.3
  body-lg:
    fontFamily: Space Grotesk
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: Space Grotesk
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: Space Grotesk
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
  button:
    fontFamily: Courier Prime
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: 0.02em
  label:
    fontFamily: Courier Prime
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.06em
  tag:
    fontFamily: Courier Prime
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.0
  tag-letter:
    fontFamily: Courier Prime
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.0
  readout:
    fontFamily: Courier Prime
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.3
  readout-lg:
    fontFamily: Courier Prime
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.0
rounded:
  none: 0px
  full: 9999px
spacing:
  hair: 1px
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
  gutter: 16px
  touch-min: 48px
  grid: 16px
  grid-major: 80px
components:
  paper-surface:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.gutter}"
  title-frame:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.line}"
    typography: "{typography.tag}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm}"
    height: 44px
  panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
  panel-active:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.instruction}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
  sheet-inverse:
    backgroundColor: "{colors.line}"
    textColor: "{colors.on-line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
    height: 52px
  button-primary-pressed:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
    height: 52px
  button-primary-disabled:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.line-faint}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
    height: 52px
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
    height: 52px
  button-outline-pressed:
    backgroundColor: "{colors.line}"
    textColor: "{colors.on-line}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
    height: 52px
  button-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-line}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
    height: 52px
  button-ink:
    backgroundColor: "{colors.on-line}"
    textColor: "{colors.line}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
    height: 52px
  icon-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    rounded: "{rounded.none}"
    size: 48px
  part-tag:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.tag-letter}"
    rounded: "{rounded.none}"
    size: 28px
  part-tag-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.tag-letter}"
    rounded: "{rounded.none}"
    size: 32px
  part-tag-done:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.line-faint}"
    typography: "{typography.tag-letter}"
    rounded: "{rounded.none}"
    size: 28px
  label-tag:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.tag}"
    rounded: "{rounded.none}"
    padding: "{spacing.xs}"
    height: 20px
  label-tag-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.tag}"
    rounded: "{rounded.none}"
    padding: "{spacing.xs}"
    height: 20px
  part-outline:
    textColor: "{colors.line}"
    rounded: "{rounded.none}"
  part-outline-active:
    textColor: "{colors.primary}"
    rounded: "{rounded.none}"
  leader-line:
    textColor: "{colors.line}"
  dimension-line:
    textColor: "{colors.line-muted}"
    typography: "{typography.readout}"
  parts-list-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.md}"
    height: 48px
  parts-list-row-active:
    backgroundColor: "{colors.primary-container}"
    textColor: "{colors.line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.md}"
    height: 48px
  step-counter:
    textColor: "{colors.line}"
    typography: "{typography.readout-lg}"
  progress-tick:
    backgroundColor: "{colors.line-faint}"
    rounded: "{rounded.none}"
    width: 16px
    height: 4px
  progress-tick-active:
    backgroundColor: "{colors.primary}"
    rounded: "{rounded.none}"
    width: 16px
    height: 4px
  check-item:
    textColor: "{colors.line}"
    typography: "{typography.body}"
    padding: "{spacing.md}"
    height: 48px
  check-item-done:
    textColor: "{colors.line-muted}"
    typography: "{typography.body}"
    padding: "{spacing.md}"
    height: 48px
  callout-dont-touch:
    backgroundColor: "{colors.error-container}"
    textColor: "{colors.error}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
  callout-caution:
    backgroundColor: "{colors.warning-container}"
    textColor: "{colors.warning}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
  callout-tip:
    backgroundColor: "{colors.info-container}"
    textColor: "{colors.info}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
  evidence-note:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line-muted}"
    typography: "{typography.tag}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm}"
  crop-marks:
    textColor: "{colors.line}"
    size: 220px
  crop-marks-locked:
    textColor: "{colors.success}"
    size: 220px
  transcript:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
  ref-thumb:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.line}"
    typography: "{typography.tag}"
    rounded: "{rounded.none}"
    width: 128px
    height: 84px
  quick-reply:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    typography: "{typography.tag}"
    rounded: "{rounded.none}"
    padding: "{spacing.md}"
    height: 40px
  text-input:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
    height: 52px
  text-input-focus:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
    height: 52px
  consent-sheet:
    backgroundColor: "{colors.line}"
    textColor: "{colors.on-line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.xl}"
  toast:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.line}"
    typography: "{typography.tag}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
    height: 40px
  orb-hero:
    textColor: "{colors.line}"
    rounded: "{rounded.full}"
    size: 200px
  orb-docked:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.line}"
    rounded: "{rounded.none}"
    size: 64px
  orb-mini:
    textColor: "{colors.line}"
    rounded: "{rounded.full}"
    size: 28px
  orb-idle:
    textColor: "{colors.line-muted}"
    rounded: "{rounded.full}"
  orb-listening:
    textColor: "{colors.line}"
    rounded: "{rounded.full}"
  orb-thinking:
    textColor: "{colors.line}"
    rounded: "{rounded.full}"
  orb-speaking:
    textColor: "{colors.primary}"
    rounded: "{rounded.full}"
  orb-asking:
    textColor: "{colors.warning}"
    rounded: "{rounded.full}"
  orb-success:
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
  orb-error:
    textColor: "{colors.error}"
    rounded: "{rounded.full}"
---

# HandyMan Drawing Sheet Design System

## Overview
HandyMan works like an IKEA manual brought to life. You point your phone camera at a geyser, washing machine or switchboard, say what you need, and it identifies the exact device and talks you through the fix, labelling each part on the live feed. Everything around the video looks like **a technical drawing sheet**: cream line work on warm charcoal drafting paper with a fine grid, boxed typewriter labels on leader lines, and hairline-framed panels, taken from the turbofan and aircraft cutaway references. It should feel **precise, calm and expert-made**, like a set of engineering plates someone drew for exactly your appliance. The **live video stream is the exception**. It stays a real camera feed, desaturated to grayscale while a part is active, and that part is the only thing in full safety orange. Anti-patterns: rounded "app" chrome (pills, cards, soft shadows), more than one accent colour, and decorative drawings that compete with the camera.

## Colors
There's one paper, one ink and one mark. **Paper** `paper` #2C3236 is the warm charcoal sheet, sampled from the references. `paper-deep` is used for frames, the title block and inputs, and `paper-raised` for disabled fills. The grid is drawn in `grid` (16px cells) and `grid-major` (every 5th line). **Ink** `line` #EAE2C6 is the cream used for all text, lines, tags and drawings (about 11:1 on paper). `line-muted` #A8A491 is for secondary text and dimensions (5.2:1). `line-faint` is for dashed construction lines and disabled states only, never for text that matters. `on-line` is paper-dark text for the inverted cream sheets. **The mark** is `primary` #FF6A1A, safety orange, reserved for the part being discussed (its tag, outline, leader, parts-list row via `primary-container`, and progress tick) and the single primary button. It reaches about 4.4:1 on paper, so use it as text only at 18px or bold. Semantic colours are muted to sit on the paper, each with a dark `*-container`: `error` means **don't touch**, `warning` means caution, `info` is a tip, and `success` is verified. Each appears only on its callout's bar, title and icon, while the body text stays `line`.

## Typography
**Courier Prime** is the typewriter mono from the references, and it's the voice of the drawing. `display`, `headline` and `title` are used for sheet titles ("Bosch Tronic 3000 T", "Step 03"). `label` (bold uppercase, +0.06em) is for section labels like "PARTS LIST", "DON'T TOUCH" and "WHAT TO CHECK". `tag` (13px, lowercase allowed) is for boxed annotations on leader lines ("cold inlet valve", "badge → bosch"). `tag-letter` is the bold A / B / C in part tags. `readout` and `readout-lg` are for dimensions, model numbers and the step counter. `button` is Courier Prime bold, so buttons read as stamped labels. **Space Grotesk** is used only for reading: `instruction` (18px) for the step, `body-lg` (17px) for the spoken transcript, and `body` and `caption` for checks, callouts and notes. Instructions are never set in Courier Prime below 18px or in all caps.

## Layout
The layout is phone-first, single-column, with a 16px `gutter` and safe-area insets. The camera screen is laid out like a drawing plate. A **title frame** (`paper-deep`, 44px) at the top holds device, model and sheet number in hairline-divided cells. The **video stream** fills the middle edge to edge, carrying the drawing overlay (tags, outlines, leaders, crop marks). **Panels** stack at the bottom (transcript, then the active step), each framed by a 1px cream hairline with a gutter between, like the plates in the turbofan reference. The orb is docked bottom-centre in its own framed square. The bottom stack stays under about 45% of viewport height and collapses when the active part is low in the frame. Off-camera screens (onboarding, history, summary) are full paper with the visible 16/80px grid. Spacing follows a 4px base. Rows and buttons are 48–52px tall.

## Elevation & Depth
There is no elevation. It's ink on one sheet of paper. Hierarchy comes from **line weight and framing**. Level 0 is paper with the grid. **Panels** are opaque paper (so the grid and video don't show through text) framed with a 1px `line` hairline at 55%. **The active panel** has a full-strength 1px `line` frame plus short corner registration ticks outside each corner. **Inverse sheets** (`sheet-inverse` and `consent-sheet`) flip to cream paper with `on-line` ink for the few moments that need full attention: safety detail, verification and booking consent. Over the camera, a bottom sheet may cast a single `0 -8px 24px` scrim shadow at 40%, purely so it separates from a bright feed. That is the only shadow in the system.

## Shapes
Everything is square (`none`), as it is in the references. That covers panels, buttons, tags, inputs, the parts-list table and the title frame. Part tags are square boxes with a bold letter. Label tags are tight rectangles hugging their text. Leader lines are 1px, angled or elbowed, and end in a 3px dot on the part. Dimension lines carry small arrowheads and extension lines. Crop marks are open L-corners. `full` is used only for the orb's circular drawing and the leader-line end dots. Dashed lines (`line-faint`, 4/3) mean construction, outlines of non-active parts or hidden edges. Solid lines mean "this is real and current".

## Components
**Surfaces:** `paper-surface` is the full-screen sheet. `title-frame` is the device/model/sheet block. `panel` is the default framed container, and `panel-active` the current step with corner ticks. `sheet-inverse` is the cream page for must-read content. **Buttons** are all square and stamped in Courier Prime bold. `button-primary` is the orange main action (one per screen), with `-pressed` and `-disabled`. `button-outline` has a cream hairline frame and inverts to cream when pressed (`button-outline-pressed`). `button-success` is used only for "It's fixed". `button-ink` is the secondary on cream sheets. `icon-button` is a framed 48px square. **Annotation:** `part-tag` is a boxed letter on paper with a cream frame. `part-tag-active` is a larger orange box. `part-tag-done` is a faint box. `label-tag` is the boxed lowercase annotation ("cold inlet valve"), with `label-tag-active` in orange. `part-outline` is dashed cream, and `part-outline-active` solid 2px orange with a 14% orange tint. `leader-line` and `dimension-line` connect and measure. **Parts list:** a ruled table of `parts-list-row`s (tag · name · spec), with `parts-list-row-active` on `primary-container`. **Step:** `step-counter` ("03/07"), a row of `progress-tick`s, the instruction, `ref-thumb`s (framed photo or video plates), `check-item`s (square box → cream tick) and `callout-dont-touch` / `-caution` / `-tip` (a coloured 3px left rule and label, with body text in cream). **Evidence:** `evidence-note` is a boxed tag ("badge top-right → bosch"), and tapping it draws a dashed frame and leader on the video. **Capture:** `crop-marks` turn into `crop-marks-locked` (green) when a close-up is captured. **Talk:** `transcript`, `quick-reply` (boxed tags), and `text-input` / `-focus` (focus uses a full-strength 1px frame plus an inner 1px offset line). **Closing the loop:** `consent-sheet` is cream and states provider, time window, cost and what's shared in a ruled table, with `button-primary` "Book handyman" and `button-ink` "Not now". `toast` is a framed paper-deep slip. **The orb** is a front-view **fan disc** like the turbofan intake in the references: an outer casing ring, an inner hub, 24 radial blades and a crosshair, all in line work. `orb-hero` (200px) is used on full-paper screens, `orb-docked` (64px) sits in a framed square over the video, and `orb-mini` is inline. States only recolour and animate the drawing. **Idle** is muted and still. **Listening** is cream, with rings breathing with mic level. **Thinking** is cream, with blades slowly rotating and a dashed construction arc sketching. **Speaking** is an orange casing ring, in sync with the active part, with blades turning and dashed rings expanding outward with voice amplitude. **Asking** is warning yellow with a "?" drawn in the hub. **Success** is green with a tick. **Error** is red with an ✗ and one jitter. Under reduced motion, keep the colour and glyphs and drop the rotation and ripples.

## Do's and Don'ts
**Do**
- Draw every overlay and panel as cream line work on charcoal paper, with square corners and 1px hairlines.
- Label parts with boxed letter tags and boxed lowercase label tags on leader lines ending in a dot.
- Keep orange for the current part and the single primary button. The rest is cream on charcoal.
- Leave the video stream photographic, and switch it to grayscale while a part is active.
- Use the cream inverse sheet for safety detail, verification and booking consent.
- Keep tap targets at least 48px and instructions in Space Grotesk at 15px or larger.

**Don't**
- Don't round anything except the orb drawing and leader dots. No pills, cards or soft shadows.
- Don't add colours beyond paper, cream and orange, apart from the four semantic states on callouts.
- Don't set long instructions or the transcript in Courier Prime. It's for labels, titles and data.
- Don't decorate the video with extra grids, fake dimensions or watermark-style drawings.
- Don't reuse or reassign part letters mid-job.
- Don't cover the active part with a panel, toast or the orb.
