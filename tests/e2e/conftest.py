"""Playwright E2E test fixtures — starts the app server for testing."""

import os
import subprocess
import time

import pytest


@pytest.fixture(scope="session")
def server():
    """Start uvicorn server for E2E tests.

    Two env-vars are critical for the cookie/origin flow over plain HTTP:
      - BUSRADAR_COOKIE_SECURE=0 drops the Secure attribute on the SSE
        cookie and falls back to the plain `busradar_sse` name. Without
        this, the browser refuses Secure cookies over plain HTTP and every
        viewport POST returns 401, status dot stays offline forever.
      - BUSRADAR_ALLOWED_ORIGINS adds the test origin so the POST handlers
        pass the Origin / Sec-Fetch-Site gate.
    """
    test_origin = "http://127.0.0.1:8111"
    env = {
        **os.environ,
        "BUSRADAR_COOKIE_SECURE": "0",
        "BUSRADAR_ALLOWED_ORIGINS": (
            "https://busradar.pihaar.de,http://localhost:8000,"
            "http://127.0.0.1:8000," + test_origin
        ),
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
    """Navigate to the app and wait for initial load."""
    page.goto(server + "/#lat=49.342&lon=8.66&z=16")
    page.wait_for_timeout(4000)
    return page
