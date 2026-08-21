"""Test configuration.

The suite must be provably unable to reach the network. `TWREV_OFFLINE=1` makes
`CachedFetcher` raise `OfflineCacheMiss` on any cache miss, so a test that
accidentally depends on a live request fails loudly instead of quietly passing
today and breaking when MOPS is down.

It is set before `twrev` is imported anywhere, because `http.py` reads the
environment at import time for its default.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ["TWREV_OFFLINE"] = "1"

REPO_ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("TWREV_ROOT", str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "ingest" / "src"))

import pytest  # noqa: E402


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return Path(__file__).parent / "fixtures"
