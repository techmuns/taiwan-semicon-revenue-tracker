"""CachedFetcher - the single place in this project that touches the network.

Everything downstream of `get()` is a pure function of bytes, which is what makes
the test suite able to run fully offline against committed fixtures.

Three properties are load-bearing:

1. **Raw bytes are cached to disk before anything parses them.** The backfill is
   296 serially-throttled requests (~15-20 min). Iterating on the parser must
   cost nothing, and the cached bytes are also the audit artifact - the evidence
   of what the source actually said on the day we asked.

2. **Bodies are validated before they enter the cache.** A truncated or
   error-page response cached as if it were real data is the worst failure mode
   available here: it would silently produce zero-row months forever, and no
   re-run would fix it. Rejected bodies go to `cache/.bad/` instead.

3. **Offline mode makes a cache miss an error.** `TWREV_OFFLINE=1` means a test
   provably cannot reach the network, rather than merely being unlikely to.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

import requests

# A plausible browser UA. MOPS serves a different (or no) response to some
# default library agents, and a Referer keeps the AJAX endpoint happy.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
}

RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504, 509, 521, 522, 524})

# Validator contract: return None to accept the body for caching, or a short
# reason string to reject it as retryable. Returning None for a legitimately
# empty response is correct and intended - see mops_company.validate_body.
Validator = Callable[[bytes], str | None]


class FetchError(RuntimeError):
    """Base for all fetch failures."""


class TransientFetchError(FetchError):
    """Worth retrying: timeout, 5xx, 429, or a body that failed validation."""


class PermanentFetchError(FetchError):
    """Not worth retrying: 404, or 4xx that is not 408/425/429."""


class OfflineCacheMiss(FetchError):
    """Offline mode was requested and the response is not cached."""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class FetchResult:
    """The outcome of a get(), whether it came from cache or the network."""
    url: str
    body: bytes
    http_status: int | None       # None when served from cache
    from_cache: bool
    sha256: str
    byte_len: int
    fetched_at_utc: str
    attempts: int = 0

    def text(self, encoding: str = "utf-8") -> str:
        """Decode with 'replace' so a stray byte cannot abort a whole backfill.

        The per-company MOPS endpoint and all three OpenAPI feeds are UTF-8, so
        replacements should be zero; `mojibake_count` is how the parser asserts that.
        """
        return self.body.decode(encoding, "replace")

    @property
    def mojibake_count(self) -> int:
        return self.text().count("�")


class CachedFetcher:
    """Rate-limited, retrying, disk-cached HTTP GET.

    Serial by construction. There is no concurrency knob, deliberately: 296
    requests is enough volume against a government disclosure site that
    politeness is also self-preservation against being rate-limited mid-backfill.
    """

    def __init__(
        self,
        cache_dir: Path,
        *,
        min_interval_s: float = 3.0,
        timeout_s: int = 45,
        max_attempts: int = 5,
        backoff_s: tuple[float, ...] = (5, 15, 45, 90),
        offline: bool | None = None,
        session: requests.Session | None = None,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.min_interval_s = min_interval_s
        self.timeout_s = timeout_s
        self.max_attempts = max(1, max_attempts)
        self.backoff_s = backoff_s
        # Explicit argument wins; otherwise the env var. Tests set the env var in
        # conftest so that *no* code path can silently reach the network.
        self.offline = (
            offline if offline is not None
            else os.environ.get("TWREV_OFFLINE", "") not in ("", "0", "false", "False")
        )
        self.session = session or requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self._last_request_at: dict[str, float] = {}
        self.stats = {"hits": 0, "misses": 0, "network": 0, "rejected": 0}

    # ---------------------------------------------------------------- caching

    def _paths(self, key: str) -> tuple[Path, Path]:
        """Cache body and sidecar metadata paths for a key.

        `key` is a caller-supplied stable name like 'mops_company/2330_11503.html'
        rather than a URL hash, so the cache stays human-browsable - being able to
        open the exact bytes for one ticker-month is worth a lot when debugging.
        """
        body = self.cache_dir / key
        return body, body.with_suffix(body.suffix + ".meta.json")

    def cached(self, key: str) -> FetchResult | None:
        body_path, meta_path = self._paths(key)
        if not (body_path.is_file() and meta_path.is_file()):
            return None
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        body = body_path.read_bytes()
        # A body that does not match its recorded digest is a corrupt cache
        # entry (interrupted write, disk issue). Treat it as a miss rather than
        # trusting it - silently parsing half a file is exactly what we are
        # protecting against.
        digest = hashlib.sha256(body).hexdigest()
        if meta.get("sha256") != digest:
            return None
        return FetchResult(
            url=meta.get("url", ""),
            body=body,
            http_status=None,
            from_cache=True,
            sha256=digest,
            byte_len=len(body),
            fetched_at_utc=meta.get("fetched_at_utc", ""),
        )

    def _write_cache(self, key: str, url: str, body: bytes, status: int) -> FetchResult:
        body_path, meta_path = self._paths(key)
        body_path.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(body).hexdigest()
        now = utc_now_iso()
        # Write the body first, then the sidecar. If we are interrupted between
        # the two, the entry reads as a miss (no meta) rather than as valid data.
        body_path.write_bytes(body)
        meta_path.write_text(
            json.dumps(
                {
                    "url": url, "sha256": digest, "byte_len": len(body),
                    "http_status": status, "fetched_at_utc": now,
                },
                indent=2, ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return FetchResult(
            url=url, body=body, http_status=status, from_cache=False,
            sha256=digest, byte_len=len(body), fetched_at_utc=now,
        )

    def file_under(self, key: str, result: FetchResult) -> FetchResult:
        """Store an already-fetched body under an additional key.

        The snapshot feeds cannot be keyed by month until the body is parsed, so
        they are fetched to a `latest` key and then filed again under the month
        they turn out to describe. Keeping both is deliberate: the dated copy is
        the audit artifact, `latest` is what the next run overwrites.
        """
        return self._write_cache(key, result.url, result.body, result.http_status)

    def _quarantine(self, key: str, body: bytes, reason: str) -> Path:
        """Park a rejected body under cache/.bad/ for inspection.

        Rejected bodies are the ones you most need to look at, and they are gone
        forever if the only record is a log line.
        """
        safe = key.replace("/", "__").replace("\\", "__")
        stamp = utc_now_iso().replace(":", "").replace("-", "")
        path = self.cache_dir / ".bad" / f"{stamp}_{safe}"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.with_suffix(path.suffix + ".reason.txt").write_text(
            f"{reason}\n", encoding="utf-8"
        )
        self.stats["rejected"] += 1
        return path

    # ------------------------------------------------------------ throttling

    def _throttle(self, url: str) -> None:
        host = urlsplit(url).netloc
        last = self._last_request_at.get(host)
        if last is not None:
            wait = self.min_interval_s - (time.monotonic() - last)
            if wait > 0:
                time.sleep(wait)
        self._last_request_at[host] = time.monotonic()

    def _sleep_backoff(self, attempt: int) -> None:
        base = self.backoff_s[min(attempt - 1, len(self.backoff_s) - 1)]
        # Jitter so a repeated failure does not turn into a synchronised retry
        # storm against the same endpoint.
        time.sleep(base * (0.75 + 0.5 * random.random()))

    # ------------------------------------------------------------------- get

    def get(
        self,
        url: str,
        key: str,
        *,
        validate: Validator | None = None,
        force_refetch: bool = False,
    ) -> FetchResult:
        """Return the response body for `url`, from cache when possible.

        Raises PermanentFetchError on 404/4xx, TransientFetchError when every
        attempt failed, and OfflineCacheMiss when offline with no cache entry.
        """
        if not force_refetch:
            hit = self.cached(key)
            if hit is not None:
                self.stats["hits"] += 1
                return hit
        self.stats["misses"] += 1

        if self.offline:
            raise OfflineCacheMiss(
                f"offline: no cache entry for {key!r} ({url}). "
                f"Run the backfill without TWREV_OFFLINE to populate it."
            )

        last_error: str = "no attempt made"
        for attempt in range(1, self.max_attempts + 1):
            self._throttle(url)
            self.stats["network"] += 1
            try:
                resp = self.session.get(url, timeout=self.timeout_s)
            except requests.RequestException as err:
                last_error = f"{type(err).__name__}: {err}"
                if attempt < self.max_attempts:
                    self._sleep_backoff(attempt)
                continue

            if resp.status_code == 404:
                raise PermanentFetchError(f"404 for {url}")
            if resp.status_code >= 400 and resp.status_code not in RETRYABLE_STATUS:
                raise PermanentFetchError(f"HTTP {resp.status_code} for {url}")
            if resp.status_code in RETRYABLE_STATUS:
                last_error = f"HTTP {resp.status_code}"
                if attempt < self.max_attempts:
                    self._sleep_backoff(attempt)
                continue

            body = resp.content
            reason = validate(body) if validate else None
            if reason is not None:
                # Validation failure is retryable: MOPS intermittently serves a
                # short holding page under load. Quarantine and try again.
                self._quarantine(key, body, f"attempt {attempt}: {reason}")
                last_error = f"body rejected: {reason}"
                if attempt < self.max_attempts:
                    self._sleep_backoff(attempt)
                continue

            result = self._write_cache(key, url, body, resp.status_code)
            result.attempts = attempt
            return result

        raise TransientFetchError(
            f"gave up on {url} after {self.max_attempts} attempts; last: {last_error}"
        )
