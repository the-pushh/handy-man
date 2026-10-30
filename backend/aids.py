"""PROTOTYPE — repair aids: real tutorial videos + reference pictures.

No browsing in the backend, so this module does the smallest live
thing that works:

- YouTube: fetch the public search page and pull the first video IDs
  out of its embedded JSON (regex on "videoId"). Residential networks
  usually get the page fine; on any failure (block, timeout, layout
  change) it returns [] and callers fall back to search links.
- Reference pictures: plain image-search URLs (always valid, one click
  from the answer). No hotlinking, no stale hardcodes.
"""

import re
import urllib.parse
import urllib.request

_YT = "https://www.youtube.com/results?search_query="


def youtube_search_url(query: str) -> str:
    return _YT + urllib.parse.quote_plus(query)


def images_search_url(query: str) -> str:
    return ("https://www.google.com/search?tbm=isch&q="
            + urllib.parse.quote_plus(query))


def fetch_video_ids(query: str, n: int = 3, timeout: int = 15) -> list:
    """Return [{"id", "title"}] for the top `n` YouTube results, or []."""
    req = urllib.request.Request(
        youtube_search_url(query),
        headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
                 "Accept-Language": "en-US,en;q=0.9"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except Exception:
        return []
    ids, seen, out = [], set(), []
    for m in re.finditer(r'"videoId":"([\w-]{11})"', html):
        vid = m.group(1)
        if vid not in seen:
            seen.add(vid)
            ids.append(vid)
        if len(ids) >= n * 3:  # oversample; shorts/dups get filtered below
            break
    return [{"id": vid, "url": f"https://www.youtube.com/watch?v={vid}"}
            for vid in ids[:n]]
