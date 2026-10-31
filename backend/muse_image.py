"""Muse Image overlay generation (repair flow).

Same gateway as Muse Spark: MUSE_SPARK_API_URL + MUSE_SPARK_API_KEY,
model id "muse-image-1.0". Image models only work on /responses
(the gateway rejects them on /chat/completions).

Request: OpenAI Responses shape {"model": "muse-image-1.0",
"input": [{role, content: [{input_text, input_image}]}]}.
Reply: output items include {"type": "image_generation_call",
"status": "completed", "result": <base64 webp>} plus an empty
output_text message. Only _request()/_result() change if the shape
differs.
"""

import base64
import json
import os
import urllib.request
import urllib.error

MODEL_ID = "muse-image-1.0"

# Evidence treatment is monochrome + orange: every part gets the same
# orange border/tint, letters (A, B, C...) tell them apart in the legend.
ORANGE = "#e86a17"
PALETTE = [ORANGE] * 8

# IKEA-style tags: A, B, C... drawn next to each part on the photo.
TAGS = ["A", "B", "C", "D", "E", "F", "G", "H"]


def _config() -> tuple:
    url = os.environ.get("MUSE_SPARK_API_URL", "").rstrip("/")
    key = os.environ.get("MUSE_SPARK_API_KEY", "")
    if not url or not key:
        raise RuntimeError(
            "Model API is not configured: set MUSE_SPARK_API_URL and "
            "MUSE_SPARK_API_KEY in .env."
        )
    return url + "/responses", key


def assign_legend(labels: list, fixed: list | None = None) -> list:
    """Canonical tag assignment: A, B, C... with fixed border colors.

    Labels already in `fixed` keep their tag/color; new labels take the
    next free letter. The walkthrough assigns once for all relevant
    parts, so every step reuses the same letters.
    """
    labels = labels or ["the faulty part"]
    fixed = fixed or []
    seen = {str(e.get("label", "")).lower(): e for e in fixed
            if isinstance(e, dict) and e.get("label")}
    legend = []
    for label in labels:
        hit = seen.get(label.lower())
        if hit and hit.get("tag") and hit.get("color"):
            legend.append({"label": label, "color": hit["color"],
                           "tag": hit["tag"]})
        else:
            i = len(fixed) + len(legend)
            legend.append({"label": label,
                           "color": PALETTE[i % len(PALETTE)],
                           "tag": TAGS[i % len(TAGS)]})
    return legend


def highlight(image_bytes: bytes, labels: list,
              fixed: list | None = None) -> dict:
    """Return {"image_b64", "mime", "legend"} with parts boxed in color.

    `legend` covers only the highlighted labels, with tags drawn from
    the canonical `fixed` assignment when given.
    """
    endpoint, key = _config()
    b64 = base64.b64encode(image_bytes).decode()
    legend = assign_legend(labels, fixed)
    orders = "; ".join(
        f'the {e["label"]}: thin solid {e["color"]} border plus the '
        f'capital letter "{e["tag"]}" drawn clearly beside it'
        for e in legend
    )
    payload = {
        "model": MODEL_ID,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text",
                 "text": (
                     f"For each of these appliance parts: {orders}. Render "
                     f"the whole image in black and white EXCEPT these "
                     f"parts: fill each one with a translucent orange tint "
                     f"and trace it with a thin solid orange border plus "
                     f"its letter tag. Everything else stays pixel-identical "
                     f"but desaturated. No text labels besides the letter "
                     f"tags, no glow, no restyling. Return the edited image."
                 )},
                {"type": "input_image",
                 "image_url": f"data:image/jpeg;base64,{b64}"},
            ],
        }],
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            reply = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:300]
        raise RuntimeError(f"Muse Image API error {exc.code}: {body}") from exc
    for item in reply.get("output", []):
        if (item.get("type") == "image_generation_call"
                and item.get("status") == "completed"
                and item.get("result")):
            return {"image_b64": item["result"], "mime": "image/webp",
                    "legend": legend}
    raise RuntimeError(
        "Muse Image returned no edited image "
        f"({json.dumps(reply.get('output', []))[:200]})"
    )
