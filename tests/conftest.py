"""Pytest configuration for Busradar BW proxy tests."""

import pytest
from httpx import ASGITransport, AsyncClient

from proxy import app


@pytest.fixture
async def client():
    """Async test client for the FastAPI app."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
