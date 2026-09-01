"""Pytest configuration for Busradar BW proxy tests."""

import json

import pytest
from httpx import ASGITransport, AsyncClient

import busradar_config
from proxy import app

# A deterministic HAFAS source + CARTO key for the whole suite. The runtime
# now sources these from the environment (busradar_config); without this the
# lazy hafas.AUTH_AID / HAFAS_ENDPOINT would be empty and envelope-shape /
# health tests could not assert real values. These are NOT secrets — they are
# obviously-fake placeholders used only to drive the config code path in tests
# and must never appear in production.
_DUMMY_CARTO_KEY = "dummy-not-a-real-carto-key"
_TEST_HAFAS_SOURCES = json.dumps(
    [
        {
            "id": "bw",
            "endpoint": "https://hafas.test/bin/mgate.exe",
            "aid": "dummy-not-a-real-aid",
            "client": {"type": "AND", "id": "DB-REGIO", "v": "3000000", "name": "DB Busradar BW"},
            "ext": "DB.REGIO.1",
            "ver": "1.39",
            "products": {"bus": 32},
        }
    ]
)


@pytest.fixture(autouse=True)
def _busradar_config(monkeypatch):
    """Configure a known CARTO key + HAFAS source and reset the config memo for
    every test. Tests that need a different/empty config set their own env and
    call busradar_config.reset() in their body (this runs first, they override)."""
    monkeypatch.setenv("BUSRADAR_CARTO_KEY", _DUMMY_CARTO_KEY)
    monkeypatch.setenv("BUSRADAR_HAFAS_SOURCES", _TEST_HAFAS_SOURCES)
    busradar_config.reset()
    yield
    busradar_config.reset()


def pytest_collection_modifyitems(items):
    """Reorder: run async unit tests BEFORE Playwright E2E tests.

    Playwright's sync runner pollutes the event loop state, causing
    'Cannot run the event loop while another loop is running' for
    subsequent pytest-asyncio fixtures.
    """
    e2e = []
    other = []
    for item in items:
        if "/e2e/" in str(item.fspath):
            e2e.append(item)
        else:
            other.append(item)
    items[:] = other + e2e


@pytest.fixture
async def client():
    """Async test client for the FastAPI app."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
