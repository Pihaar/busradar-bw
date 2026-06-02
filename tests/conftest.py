"""Pytest configuration for Busradar BW proxy tests."""

import pytest
from httpx import ASGITransport, AsyncClient

from proxy import app


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
