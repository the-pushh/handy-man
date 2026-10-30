"""Language detection mapped onto the real MMS-TTS voice list.

Coverage reality (999 checkpoints in backend/mms_languages.json):
  - Detection: Hinglish lexicon + script checks + `langdetect` (~55 langs).
  - Voice: any MMS checkpoint, incl. script variants (urd-script_arabic).
    Genuinely absent voices (e.g. Mandarin, Norwegian, Portuguese) fall
    back to English explicitly — never a wrong-language voice.
  - Narration text: authored en/hi/hinglish, NLLB-translated for the rest
    on first use (backend/i18n.py), English fallback when untranslatable.

Hinglish (and code-mix generally) is checked FIRST: generic identifiers
call Latin-script Hindi "English", so the matrix-language lexicon wins.
"""

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path


def _norm(word: str) -> str:
    """Lowercase ASCII fold so 'está' matches lexicon 'esta'."""
    return "".join(
        c for c in unicodedata.normalize("NFKD", word.lower())
        if not unicodedata.combining(c))

DEVANAGARI = re.compile(r"[\u0900-\u097F]")

# Frequent Hindi function/content words in Latin script. Any two in one
# utterance is a strong Hinglish signal (single loans like "geyser" alone
# must NOT flip the language).
HINGLISH_WORDS = frozenset("""
hai hain hoon ho raha rahi rahe tha thi the kya kyon kyun kaise kab kahan
nahi nahin nahiin mat ka ki ke ko ne se mein me par per aur ya lekin magar
yeh yah woh wo ye vo jo jis jisne apna apne mera mere tera tere hamara
hamare tumhara tumhare bahut zyada thoda kam accha achha kharab naya purana
bada chota garam thanda pani bijli light band chalu karo karna hota hoga
chahiye samajh dekho dikhao bolo suno theek sahi galat abhi phir wapas
andar bahar upar neeche samne peeche paas door kitna kaun kisko kisme
""".split())

# Authored narration lives in voice_lines for these three only.
AUTHORED = ("en", "hi", "hinglish")

# Function-word lexicons: langdetect is confidently wrong on short Latin
# text, so an outright lexicon win (>=2 hits, strict max) overrules it.
# Lists are curated to avoid cross-language collisions ("no"/"me"/"is"
# style words are deliberately absent).
LEXICONS = {
    "es": """el los las una son estoy hay para porque pero este esta estos
        muy sin del qué cómo cuándo cuál desde hasta tengo tiene fueron
        mi con por agua fuga gotea ruido luz roto lavadora""",
    "fr": """le les des est sont suis avons avez pour parce mais avec sans
        dans très plus cette ces ton notre votre qui quoi comment quand
        comme mon eau bruit panne fuite casse marche ne pas""",
    "nl": """de het een van ik mijn jouw niet geen met zonder voor omdat
        maar als wanneer waar waarom hoe wat welke wie stuk kraan lekt
        lekken warm koud licht warm water op heet""",
    "de": """der die das eine ist sind habe hast haben für weil aber ohne
        sehr mehr nicht keine dieser diese mein dein sein unser wer wann
        warum auch nur schon wasser strom laut kaputt undicht
        waschmaschine""",
    "it": """il gli della sono siamo hanno perché senza molto più questo
        questa quello quando dove quale nostro vostro anche sempre mi mio
        con acqua rumore rotto guasto perdita""",
    "pt": """uma para porque mas sem muito mais este esta isso quando onde
        qual meu seu nosso vosso também sempre estou temos foram minha
        agua barulho quebrado vazamento chuveiro""",
    "en": """the are have has had not but your their very with that this
        these those from what when where which how why will would there
        here about been does into over because while again my water leak
        leaks leaking noise noisy loud power broken breaker washing""",
}
LEXICONS = {k: frozenset(_norm(w) for w in v.split())
            for k, v in LEXICONS.items()}

# Hinglish words that also exist in European languages (Italian "ne"/"ho",
# Spanish "se"/"me") count half: two of them alone must not flip the
# language, but they support a strong Hindi word ("hai" + "ho" still wins).
WEAK_HINGLISH = frozenset(
    "ho ne se me par per ka ki ke ko jo ye wo mein".split())

# BCP-47 regions for the recognizer; generic {pt1}-{PT1} otherwise.
STT_REGIONS = {
    "en": "US", "hi": "IN", "de": "DE", "fr": "FR", "es": "ES",
    "it": "IT", "pt": "BR", "nl": "NL", "ru": "RU", "ja": "JP",
    "ko": "KR", "zh": "CN", "ar": "SA", "tr": "TR", "pl": "PL",
    "uk": "UA", "vi": "VN", "th": "TH", "id": "ID", "ms": "MY",
    "bn": "BD", "ta": "IN", "te": "IN", "mr": "IN", "gu": "IN",
    "kn": "IN", "ml": "IN", "pa": "IN", "ur": "PK", "fa": "IR",
    "ne": "NP", "sw": "KE",
}

_MMS_FILE = Path(__file__).resolve().parent / "mms_languages.json"


@lru_cache(maxsize=1)
def mms_codes() -> frozenset:
    try:
        return frozenset(json.loads(_MMS_FILE.read_text()))
    except Exception:
        return frozenset({"eng", "hin"})


def _iso3(iso1: str) -> str:
    try:
        from iso639 import Lang
        return Lang(iso1).pt3 or ""
    except Exception:
        return ""


def language_name(code: str) -> str:
    """English name for an MMS code ('urd-script_arabic' -> 'Urdu')."""
    try:
        from iso639 import Lang
        return Lang(code.split("-script_")[0]).name
    except Exception:
        return code


def stt_locale(iso1: str) -> str:
    region = STT_REGIONS.get(iso1, iso1.upper())
    return f"{iso1}-{region}"


def text_script(text: str) -> str:
    """Dominant MMS script suffix in the text, '' when unclear/absent."""
    import unicodedata as _ud
    counts: dict = {}
    for ch in text:
        if ch.isalpha():
            try:
                top = _ud.name(ch).split()[0]
            except ValueError:
                continue
            counts[top] = counts.get(top, 0) + 1
    if not counts:
        return ""
    return {"ARABIC": "arabic", "DEVANAGARI": "devanagari",
            "CYRILLIC": "cyrillic", "ETHIOPIC": "ethiopic",
            "LATIN": "latin", "TELUGU": "telugu",
            "TIFINAGH": "tifinagh", "CANADIAN": "syllabics"}.get(
                max(counts, key=counts.get), "")


def resolve_voice(iso3: str, script: str) -> str | None:
    """Best MMS checkpoint for an ISO 639-3 code + text script (or None)."""
    codes = mms_codes()
    if not iso3:
        return None
    if script:
        variant = f"{iso3}-script_{script}"
        if variant in codes:
            return variant
    if iso3 in codes:
        return iso3
    return None


def detect_language(text: str) -> dict:
    """Detect transcript language -> MMS voice + narration plan.

    Returns {"code", "narration", "tts", "stt", "voice_ok"} where `code`
    is the MMS checkpoint suffix (or ""), `narration` is "en"/"hi"/
    "hinglish"/<mms code for NLLB>/​"en"-fallback, `tts` the full
    "facebook/mms-tts-XXX" id (or None), and `stt` a BCP-47 locale hint.
    """
    t = (text or "").strip()
    if not t:
        return _bundle("eng", "en", "en")

    # 1. Code-mix / Hinglish first (generic identifiers miss it).
    if DEVANAGARI.search(t):
        latin_words = re.findall(r"[a-zA-Z]{3,}", t)
        if len(latin_words) >= 2:
            return _bundle("hin", "hinglish", "hi")
        iso1 = _langdetect(t)
        if iso1 not in ("hi", "mr", "ne"):
            iso1 = "hi"
        iso3 = _iso3(iso1) or "hin"
        voice = resolve_voice(iso3, "devanagari") or resolve_voice("hin", "devanagari")
        if voice == "hin" or (voice or "").startswith("hin"):
            return _bundle(voice or "hin", "hi", iso1)
        if voice:
            base = voice.split("-script_")[0]
            return _bundle(voice, _narratable_or_en(base), iso1)
        return _bundle("", "hi", iso1)
    words = {_norm(w) for w in re.findall(r"[a-zA-ZÀ-ÿ']+", t)}
    hinglish_hits = words & HINGLISH_WORDS
    hinglish_score = sum(0.5 if w in WEAK_HINGLISH else 1.0
                         for w in hinglish_hits)
    if hinglish_score >= 2:
        return _bundle("hin", "hinglish", "hi")

    # 2. Function-word lexicons outrank statistical guesses on short text.
    # English is the default language: one curated function word claims it
    # (the list avoids Romance/Germanic collisions); others need two hits.
    # Characteristic word pairs ("se me rompió" is Spanish, not Catalan).
    bigrams = {"se me": "es", "se te": "es", "chez moi": "fr", "bei mir": "de"}
    bonus = {code: 0 for code in LEXICONS}
    for phrase, code in bigrams.items():
        if all(w in words for w in phrase.split()):
            bonus[code] += 2
    thresholds = {code: 1 if code == "en" else 2 for code in LEXICONS}
    scores = sorted(((len(words & LEXICONS[code]) + bonus[code], code)
                     for code in LEXICONS), reverse=True)
    top_hits, top_code = scores[0]
    if top_hits >= thresholds[top_code] and top_hits > scores[1][0]:
        iso1 = top_code
        iso3 = _iso3(iso1)
        voice = resolve_voice(iso3, text_script(t))
        if voice:
            base = voice.split("-script_")[0]
            narration = "en" if base == "eng" else _narratable_or_en(base)
            return _bundle(voice, narration, iso1)
        return _bundle("", "en", iso1)

    # 3. CJK disambiguation: pure Hanzi is Chinese (no MMS voice -> honest
    # English fallback with a Chinese recognizer), kana implies Japanese,
    # Hangul implies Korean.
    cjk = _cjk(t)
    if cjk:
        iso1 = cjk
        iso3 = _iso3(iso1)
        voice = resolve_voice(iso3, text_script(t))
        if voice:
            return _bundle(voice, voice, iso1)
        return _bundle("", "en", iso1)

    # 4. Generic identification -> ISO 639-3 -> MMS voice (+script variant).
    iso1 = _langdetect(t) or "en"
    iso3 = _iso3(iso1)
    voice = resolve_voice(iso3, text_script(t))
    if voice:
        base = voice.split("-script_")[0]
        narration = "en" if base == "eng" else _narratable_or_en(base)
        return _bundle(voice, narration, iso1)
    # Detectable but no MMS voice (e.g. Mandarin, Norwegian): say so,
    # narrate in English rather than a wrong-language voice.
    return _bundle("", "en", iso1)


def _cjk(text: str) -> str:
    """ja/ko/zh guess from scripts (langdetect mixes these up)."""
    import unicodedata as _ud
    names = []
    for ch in text:
        if ch.strip():
            try:
                names.append(_ud.name(ch).split()[0])
            except ValueError:
                pass
    if not names:
        return ""
    has_hans = any(n == "CJK" for n in names)
    if not has_hans:
        return ""
    if any(n in ("HIRAGANA", "KATAKANA") for n in names):
        return "ja"
    if any(n == "HANGUL" for n in names):
        return "ko"
    return "zh"


def _langdetect(text: str) -> str:
    try:
        from langdetect import detect as _detect
        code = _detect(text)
        return {"zh-cn": "zh", "zh-tw": "zh"}.get(code, code)
    except Exception:
        return ""


def _narratable_or_en(code: str) -> str:
    """Keep a narration language only if authored or NLLB-translatable."""
    if code in ("en", "hi", "hinglish"):
        return code
    try:
        from .i18n import can_narrate
        return code if can_narrate(code) else "en"
    except Exception:
        return "en"


def _src(iso1: str) -> str:
    try:
        from .i18n import src_nllb_for_iso1
        return src_nllb_for_iso1(iso1 or "en")
    except Exception:
        return ""


def _bundle(voice: str, narration: str, iso1: str) -> dict:
    return {
        "code": voice,
        "narration": narration,
        "tts": f"facebook/mms-tts-{voice}" if voice else None,
        "stt": stt_locale(iso1 or "en"),
        "voice_ok": bool(voice),
        # NLLB source for reverse-translating the transcript to English
        # (symptom/device matching), even when replying in English.
        "src": _src(iso1),
    }
