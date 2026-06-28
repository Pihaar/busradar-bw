"""Playwright E2E test fixtures — starts the app server for testing."""

import os
import subprocess
import time

import pytest


@pytest.fixture(scope="session")
def server():
    """Start uvicorn server for E2E tests.

    Env-vars that keep the test server quiet enough for parallel browser
    contexts:
      - BUSRADAR_COOKIE_SECURE=0 drops the Secure attribute on the SSE
        cookie and falls back to the plain `busradar_sse` name. Without
        this, the browser refuses Secure cookies over plain HTTP and every
        viewport POST returns 401, status dot stays offline forever.
      - BUSRADAR_ALLOWED_ORIGINS adds the test origin so the POST handlers
        pass the Origin / Sec-Fetch-Site gate.
      - BUSRADAR_SKIP_STOPS_REBUILD=1 keeps the on-startup stops cache
        rebuild from firing. The rebuild fans out hundreds of HAFAS POSTs
        through the shared httpx client and starves the event loop for
        long enough that a second Playwright BrowserContext.goto() times
        out at the navigation-complete event. Production keeps the
        nightly rebuild via the daily scheduler; for tests the on-disk
        cache is fresh enough.
    """
    test_origin = "http://127.0.0.1:8111"
    env = {
        **os.environ,
        "BUSRADAR_COOKIE_SECURE": "0",
        "BUSRADAR_ALLOWED_ORIGINS": (
            "https://busradar.pihaar.de,http://localhost:8000,"
            "http://127.0.0.1:8000," + test_origin
        ),
        "BUSRADAR_SKIP_STOPS_REBUILD": "1",
        # The whole suite drives one IP (127.0.0.1) through ~20 page loads
        # in two minutes; the production-default burst of 30 tokens / 1 token-
        # per-second refill leaves the bucket empty by the time the last few
        # tests run, which silently turns load-more clicks into 429s and
        # makes the +1d badge test in test_special_stops.py flaky. The
        # bucket is per-IP only in production; the env override is what
        # the conftest uses to keep the E2E run deterministic.
        "BUSRADAR_POST_RATE_BURST": "500",
    }
    proc = subprocess.Popen(
        ["python3", "-m", "uvicorn", "proxy:app", "--host", "127.0.0.1", "--port", "8111"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    time.sleep(2)
    yield test_origin
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture
def app_page(page, server):
    """Navigate to the app and wait for initial load.

    wait_until="domcontentloaded" instead of the default "load" — the page
    holds a long-lived SSE EventSource open, which keeps the document's
    `load` event pending and can race the 30s navigation timeout when the
    upstream HAFAS call takes a few seconds. Once DOM is parsed, the
    explicit wait_for_timeout below covers the SSE handshake and the first
    vehicles tick anyway."""
    page.goto(server + "/#lat=49.342&lon=8.66&z=16", wait_until="domcontentloaded")
    page.wait_for_timeout(4000)
    return page
