"""Per-IP and per-session limits that keep a free, login-less app affordable.

In memory, per instance: with Cloud Run capped at 3 instances, a visitor
spread across all of them gets at most 3x the configured numbers, which
is fine for protecting the bill (the GCP budget alert is the backstop).
No database, nothing written to disk.
"""

import threading
import time
from collections import defaultdict, deque


class Window:
    """At most `limit` events per `seconds` per key (sliding window)."""

    def __init__(self, limit: int, seconds: int):
        self.limit = limit
        self.seconds = seconds
        self._hits: dict = defaultdict(deque)
        self._lock = threading.Lock()

    def take(self, key: str, now: float | None = None) -> int:
        """Record one event. Returns 0 if allowed, else seconds to wait."""
        if not self.limit:
            return 0
        now = time.monotonic() if now is None else now
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] >= self.seconds:
                q.popleft()
            if len(q) >= self.limit:
                return max(1, int(self.seconds - (now - q[0])) + 1)
            q.append(now)
            if len(self._hits) > 50_000:  # drop idle keys, bound memory
                for k in [k for k, v in self._hits.items() if not v][:10_000]:
                    del self._hits[k]
            return 0


def wait_text(seconds: int) -> str:
    minutes = (seconds + 59) // 60
    return f"{minutes} minute{'s' if minutes != 1 else ''}"
