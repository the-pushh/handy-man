"""Spoken + shown narration lines in the user's own language.

Keys: "en" (English), "hi" (Hindi, Devanagari), "hinglish" (Hindi matrix
with English loans, authored in Devanagari so mms-tts-hin pronounces it
correctly — there is no separate Hinglish acoustic model).
"""

DEVICE_KEYWORDS = (
    ("geyser", ("geyser", "गीज़र", "गीज़र")),
    ("गीज़र", ("geyser", "गीज़र", "गीज़र")),
    ("गीजर", ("geyser", "गीज़र", "गीज़र")),
    ("washing", ("washing machine", "वॉशिंग मशीन", "वॉशिंग मशीन")),
    ("washer", ("washing machine", "वॉशिंग मशीन", "वॉशिंग मशीन")),
    ("वॉशिंग", ("washing machine", "वॉशिंग मशीन", "वॉशिंग मशीन")),
    ("switchboard", ("switchboard", "स्विचबोर्ड", "स्विचबोर्ड")),
    ("switch board", ("switchboard", "स्विचबोर्ड", "स्विचबोर्ड")),
    ("switch", ("switchboard", "स्विचबोर्ड", "स्विचबोर्ड")),
    ("स्विच", ("switchboard", "स्विचबोर्ड", "स्विचबोर्ड")),
    ("breaker", ("switchboard", "स्विचबोर्ड", "स्विचबोर्ड")),
)

FALLBACK_DEVICE = ("appliance", "उपकरण", "अप्लायंस")

LANG_INDEX = {"en": 0, "hi": 1, "hinglish": 2}


def infer_device(transcript: str, lang: str) -> str:
    t = (transcript or "").lower()
    idx = LANG_INDEX.get(lang, 0)
    for keyword, names in DEVICE_KEYWORDS:
        if keyword in t:
            return names[idx]
    return FALLBACK_DEVICE[idx]


LINES = {
    "heard": (
        "Got it — analyzing now.",
        "समझ गया — विश्लेषण शुरू कर रहा हूँ।",
        "समझ गया — एनालिसिस शुरू कर रहा हूँ।",
    ),
    "capturing": (
        "Grabbing a still of the problem area.",
        "समस्या वाली जगह की तस्वीर ले रहा हूँ।",
        "प्रॉब्लम वाली जगह की फ़ोटो ले रहा हूँ।",
    ),
    "finding_device": (
        "Finding the device.",
        "डिवाइस ढूँढ रहा हूँ।",
        "डिवाइस ढूँढ रहा हूँ।",
    ),
    "device_found": (
        "Device found — looks like a {device}.",
        "डिवाइस मिल गया — {device} लग रहा है।",
        "डिवाइस मिल गया — {device} लग रहा है।",
    ),
    "region": (
        "Checking country-specific model variants.",
        "क्षेत्र के हिसाब से मॉडल वेरिएंट देख रहा हूँ।",
        "कंट्री-स्पेसिफ़िक मॉडल वेरिएंट चेक कर रहा हूँ।",
    ),
    "logo": (
        "Searching for the brand logo.",
        "ब्रांड लोगो खोज रहा हूँ।",
        "ब्रांड लोगो सर्च कर रहा हूँ।",
    ),
    "logo_found": (
        "Logo region found — confirming the model from it.",
        "लोगो वाला हिस्सा मिल गया — इससे मॉडल की पहचान हो रही है।",
        "लोगो वाला portion मिल गया — इससे मॉडल identify हो रहा है।",
    ),
    "components": (
        "Marking the internal components.",
        "अंदर के पुर्ज़े चिह्नित कर रहा हूँ।",
        "components mark कर रहा हूँ।",
    ),
    "pinpoint": (
        "Pinpointing the problem area.",
        "खराबी वाली जगह तय कर रहा हूँ।",
        "problem area pinpoint कर रहा हूँ।",
    ),
    "done": (
        "Analysis complete — here are the probable causes.",
        "विश्लेषण पूरा — संभावित कारण सुनिए।",
        "analysis complete — probable causes सुनिए।",
    ),
}

# symptom family -> (title, explanation) per language
CAUSES = {
    "leak": (
        ("Water inlet / hose fault",
         "Leaks near the base usually come from the inlet hose or pump seal."),
        ("पानी का रिसाव / पाइप दोष",
         "नीचे की ओर रिसाव आमतौर पर इनलेट पाइप या पंप सील से होता है।"),
        ("पानी leakage / hose fault",
         "base के पास leakage usually inlet hose या pump seal से होता है।"),
    ),
    "noise": (
        ("Unbalanced load or worn bearing",
         "Loud spin cycles often mean an unbalanced drum or a worn bearing."),
        ("असंतुलित लोड या घिसा बेयरिंग",
         "तेज़ आवाज़ वाले स्पिन का मतलब अक्सर असंतुलित ड्रम या घिसा बेयरिंग है।"),
        ("unbalanced load या worn bearing",
         "loud spin का मतलब usually unbalanced drum या worn bearing है।"),
    ),
    "power": (
        ("Power supply / breaker fault",
         "No power usually traces to the supply, fuse, or breaker row."),
        ("बिजली आपूर्ति / ब्रेकर दोष",
         "बिजली न आने का कारण आमतौर पर सप्लाई, फ़्यूज़ या ब्रेकर होता है।"),
        ("power supply / breaker fault",
         "No power usually supply, fuse या breaker row की वजह से होता है।"),
    ),
    "fallback": (
        ("Needs visual inspection",
         "Describe the symptom and I will narrow it down once components are segmented."),
        ("जाँच आवश्यक",
         "लक्षण बताइए, पुर्ज़े चिह्नित होते ही कारण सीमित कर दूँगा।"),
        ("visual inspection needed",
         "symptom बताइए, components mark होते ही cause narrow down कर दूँगा।"),
    ),
}

# repair steps, {part} filled with the related component label
STEPS = (
    (
        "Power off the unit and confirm it is safe to touch.",
        "यूनिट बंद करें और छूने से पहले सुरक्षित होने की पुष्टि करें।",
        "unit off करें और confirm करें कि touch करना safe है।",
    ),
    (
        "Inspect {part} for visible damage or loose connections.",
        "दिखाई देने वाली खराबी या ढीले कनेक्शन के लिए {part} की जाँच करें।",
        "visible damage या loose connections के लिए {part} inspect करें।",
    ),
    (
        'Say "next" when ready and I will walk you through the fix.',
        'तैयार हों तो "next" कहें, मैं आगे का तरीका बताऊँगा।',
        'ready हों तो "next" बोलें, मैं fix walkthrough कराऊँगा।',
    ),
)


def line(key: str, lang: str, **kwargs: str) -> str:
    idx = LANG_INDEX.get(lang, 0)
    return LINES[key][idx].format(**kwargs)


def cause_for(transcript: str, lang: str, part: str | None) -> dict:
    t = (transcript or "").lower()
    if ("leak" in t or "water" in t or "leakage" in t
            or "पानी" in t or "रिसाव" in t or "लीक" in t):
        family = "leak"
    elif any(w in t for w in ("noise", "loud", "vibrat", "shak", "आवाज़", "आवाज", "शोर")):
        family = "noise"
    elif "power" in t or "not turning on" in t or "dead" in t or "बिजली" in t:
        family = "power"
    else:
        family = "fallback"
    idx = LANG_INDEX.get(lang, 0)
    title, explanation = CAUSES[family][idx]
    confidence = 0.6 if family == "leak" else 0.55 if family != "fallback" else 0.4
    return {"title": title, "explanation": explanation,
            "relatedComponentLabel": part, "confidence": confidence}


def steps_for(lang: str, part: str | None) -> list:
    idx = LANG_INDEX.get(lang, 0)
    label = part or ("the highlighted part", "हाइलाइट किया हिस्सा", "highlighted part")[idx]
    return [{"index": i, "instruction": template[idx].format(part=label),
             "highlightLabel": part}
            for i, template in enumerate(STEPS)]
