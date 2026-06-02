"""Playwright E2E test fixtures — starts the app server for testing."""

import subprocess
import time

import pytest


@pytest.fixture(scope="session")
def server():
    """Start uvicorn server for E2E tests."""
    proc = subprocess.Popen(
        ["python3", "-m", "uvicorn", "proxy:app", "--host", "127.0.0.1", "--port", "8111"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    time.sleep(2)
    yield "http://127.0.0.1:8111"
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture
def app_page(page, server):
    """Navigate to the app and wait for initial load."""
    page.goto(server + "/#lat=49.342&lon=8.66&z=16")
    page.wait_for_timeout(4000)
    return page
