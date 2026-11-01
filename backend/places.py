"""Nearby pros via Google Places API (New), proxied so the key stays here.

Config: GOOGLE_PLACES_API_KEY (server-side only, never sent to the
browser). The trade comes from the rules layer's verdict (risk.py).

Two endpoints of Places API (New):
  - Nearby Search (places:searchNearby) when Places has a type for the
    trade (electrician).
  - Text Search (places:searchText) with a location bias for trades
    Places has no type for (two-wheeler mechanic, inverter / battery
    service, AC technician, ...). Results are ranked by distance.

No scraping and no manual-entry fallback: no key or no results means an
empty list with a reason, and the UI offers a Google Maps search link.
"""

import json
import math
import os
import urllib.error
import urllib.request

from . import trace

BASE = "https://places.googleapis.com/v1/places"
FIELDS = ",".join([
    "places.id", "places.displayName", "places.formattedAddress",
    "places.location", "places.currentOpeningHours.openNow",
    "places.nationalPhoneNumber", "places.internationalPhoneNumber",
    "places.rating", "places.userRatingCount", "places.googleMapsUri",
    "places.businessStatus",
])

# trade -> ("nearby", [types]) or ("text", query)
TRADES = {
    "electrician": ("nearby", ["electrician"]),
    "two-wheeler mechanic": ("text", "two wheeler mechanic scooter repair"),
    "inverter / battery service": ("text", "inverter battery service shop"),
    "battery service": ("text", "battery service shop"),
    "AC technician": ("text", "AC repair service technician"),
    "appliance technician": ("text", "home appliance repair service"),
    "laptop repair": ("text", "laptop repair shop"),
    "laptop / phone repair": ("text", "laptop phone repair shop"),
    "gas technician": ("text", "LPG gas stove repair service"),
}


def _key() -> str:
    key = os.environ.get("GOOGLE_PLACES_API_KEY", "").strip()
    if not key:
        raise LookupError("GOOGLE_PLACES_API_KEY is not set on the server.")
    return key


def _post(path: str, body: dict, key: str) -> dict:
    req = urllib.request.Request(
        f"{BASE}:{path}", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Places API error {exc.code}: "
                           f"{exc.read().decode(errors='replace')[:300]}")


def _km(lat1, lng1, lat2, lng2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def nearby(trade: str, lat: float, lng: float, radius_m: int = 5000,
           limit: int = 8) -> list:
    """[{name, address, distance_km, open_now, phone, rating, maps_url}]."""
    key = _key()
    mode, what = TRADES.get(trade, ("text", trade or "repair service"))
    circle = {"circle": {"center": {"latitude": lat, "longitude": lng},
                         "radius": float(radius_m)}}
    with trace.call(f"Google Places (New) {'Nearby' if mode == 'nearby' else 'Text'} Search",
                    f"find: {trade}", kind="hop") as rec:
        if mode == "nearby":
            reply = _post("searchNearby", {
                "includedTypes": what, "maxResultCount": limit,
                "rankPreference": "DISTANCE",
                "locationRestriction": circle}, key)
        else:
            reply = _post("searchText", {
                "textQuery": what, "pageSize": limit,
                "rankPreference": "DISTANCE",
                "locationBias": circle}, key)
        out = []
        for p in reply.get("places", []):
            if p.get("businessStatus") not in (None, "OPERATIONAL"):
                continue
            loc = p.get("location") or {}
            out.append({
                "id": p.get("id"),
                "name": (p.get("displayName") or {}).get("text", ""),
                "address": p.get("formattedAddress", ""),
                "distance_km": round(_km(lat, lng, loc.get("latitude", lat),
                                         loc.get("longitude", lng)), 1),
                "open_now": (p.get("currentOpeningHours") or {}).get("openNow"),
                "phone": p.get("internationalPhoneNumber")
                or p.get("nationalPhoneNumber"),
                "rating": p.get("rating"),
                "ratings": p.get("userRatingCount"),
                "maps_url": p.get("googleMapsUri"),
            })
        out.sort(key=lambda x: x["distance_km"])
        rec["parsed"] = {"query": what, "results": len(out)}
        return out[:limit]
