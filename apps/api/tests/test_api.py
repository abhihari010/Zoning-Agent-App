from __future__ import annotations

import shutil
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage import store


@pytest.fixture(autouse=True)
def clear_store() -> None:
    store.reset()


def test_intake_missing_google_key_returns_503(monkeypatch):
    client = TestClient(app)

    monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)

    payload = {
        "session_id": str(uuid4()),
        "project_description": "Convert garage to bakery with two employees and set operating hours.",
        "address": "123 Main St, Springfield",
    }

    response = client.post("/api/v1/projects/intake", json=payload)
    assert response.status_code == 503
    assert "GOOGLE_MAPS_API_KEY" in response.json()["detail"]


def test_intake_invalid_address_returns_invalid_status(monkeypatch):
    client = TestClient(app)

    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "demo-key")

    from app import services

    def fake_normalize(_: str):
        return services.AddressNormalizationResult(
            normalized_address="Bad",
            district="unknown",
            place_id=None,
            latitude=None,
            longitude=None,
            is_valid=False,
            warnings=["Address could not be validated with Google Maps APIs."],
        )

    monkeypatch.setattr("app.routers.api.normalize_address", fake_normalize)

    payload = {
        "session_id": str(uuid4()),
        "project_description": "Convert garage to bakery with two employees and set operating hours.",
        "address": "Nowhere",
    }

    response = client.post("/api/v1/projects/intake", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "invalid_address"
    assert body["district"] == "unknown"


def test_intake_success_persists_geodata(monkeypatch):
    client = TestClient(app)

    from app import services

    def fake_normalize(_: str):
        return services.AddressNormalizationResult(
            normalized_address="123 Main St, Springfield",
            district="mixed-use-core",
            place_id="place-123",
            latitude=40.0,
            longitude=-74.0,
            is_valid=True,
            warnings=[],
        )

    monkeypatch.setattr("app.routers.api.normalize_address", fake_normalize)

    payload = {
        "session_id": str(uuid4()),
        "project_description": "Convert garage to bakery with two employees and set operating hours.",
        "address": "123 Main St",
    }

    response = client.post("/api/v1/projects/intake", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "created"
    assert body["place_id"] == "place-123"
    assert body["latitude"] == 40.0

    project_id = body["project_id"]
    project = store.get_project(UUID(project_id))
    assert project is not None
    assert project.place_id == "place-123"


def test_address_suggest_returns_suggestions(monkeypatch):
    client = TestClient(app)

    monkeypatch.setattr(
        "app.routers.api.suggest_addresses",
        lambda query, session_token=None: ["123 Main St, Springfield", "125 Main St, Springfield"],
    )

    response = client.get("/api/v1/address/suggest", params={"query": "123 Mai"})
    assert response.status_code == 200
    body = response.json()
    assert body["suggestions"][0] == "123 Main St, Springfield"


def test_project_trace_returns_audit_events(monkeypatch):
    client = TestClient(app)

    from app import services

    def fake_normalize(_: str):
        return services.AddressNormalizationResult(
            normalized_address="123 Main St, Springfield",
            district="mixed-use-core",
            place_id="place-123",
            latitude=40.0,
            longitude=-74.0,
            is_valid=True,
            warnings=[],
        )

    monkeypatch.setattr("app.routers.api.normalize_address", fake_normalize)

    intake_response = client.post(
        "/api/v1/projects/intake",
        json={
            "session_id": str(uuid4()),
            "project_description": "Convert garage to bakery with two employees and renovation plans.",
            "address": "123 Main St",
        },
    )
    assert intake_response.status_code == 200
    project_id = intake_response.json()["project_id"]

    trace_response = client.get(f"/api/v1/projects/{project_id}/trace")
    assert trace_response.status_code == 200
    events = trace_response.json()["events"]
    assert any(event["stage"] == "project.created" for event in events)
    assert any(event["stage"] == "project.intake.validated" for event in events)


def test_feedback_persists_and_returns_accepted(monkeypatch):
    client = TestClient(app)

    from app import services

    def fake_normalize(_: str):
        return services.AddressNormalizationResult(
            normalized_address="123 Main St, Springfield",
            district="mixed-use-core",
            place_id="place-123",
            latitude=40.0,
            longitude=-74.0,
            is_valid=True,
            warnings=[],
        )

    monkeypatch.setattr("app.routers.api.normalize_address", fake_normalize)

    intake_response = client.post(
        "/api/v1/projects/intake",
        json={
            "session_id": str(uuid4()),
            "project_description": "Convert garage to bakery with two employees and renovation plans.",
            "address": "123 Main St",
        },
    )
    project_id = intake_response.json()["project_id"]

    feedback_response = client.post(
        f"/api/v1/projects/{project_id}/feedback",
        json={
            "project_id": project_id,
            "helpful": True,
            "comment": "The checklist is clear.",
        },
    )

    assert feedback_response.status_code == 200
    assert feedback_response.json()["status"] == "accepted"

    trace_response = client.get(f"/api/v1/projects/{project_id}/trace")
    events = trace_response.json()["events"]
    assert any(event["stage"] == "feedback.received" for event in events)
    assert any(event["stage"] == "feedback.saved" for event in events)


def test_ingestion_sources_seed_and_upsert():
    client = TestClient(app)

    list_response = client.get("/api/v1/ingestion/sources")
    assert list_response.status_code == 200
    sources = list_response.json()["sources"]
    assert len(sources) >= 3

    upsert_response = client.post(
        "/api/v1/ingestion/sources",
        json={
            "source": {
                "source_id": "parking-code-2.9",
                "title": "Parking Code 2.9",
                "excerpt": "Small commercial conversions must maintain two off-street spaces.",
                "section_ref": "Sec 2.9",
                "url": "https://example.gov/parking/2.9",
                "effective_date": "2025-02-01",
                "districts": ["mixed-use-core"],
                "uses": ["home-based-food-business"],
            }
        },
    )
    assert upsert_response.status_code == 200
    updated_sources = upsert_response.json()["sources"]
    assert any(source["source_id"] == "parking-code-2.9" for source in updated_sources)


def test_ingestion_reindex_reports_source_count():
    client = TestClient(app)

    response = client.post("/api/v1/ingestion/reindex")
    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert response.json()["source_count"] >= 3


def test_import_local_docs_endpoint():
    client = TestClient(app)

    temp_dir = Path(__file__).resolve().parent / "_tmp_api_import"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True)

    try:
        doc_path = temp_dir / "local-rule.md"
        doc_path.write_text(
            "\n".join(
                [
                    "title: Local Rule",
                    "section_ref: Sec 9.1",
                    "districts: mixed-use-core",
                    "uses: general",
                    "",
                    "Neighborhood retail uses may require frontage review.",
                ]
            ),
            encoding="utf-8",
        )

        response = client.post(
            "/api/v1/ingestion/import-local-docs",
            json={"directory": str(temp_dir)},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "completed"
        assert body["imported_count"] == 1
        assert "local-rule" in body["imported_source_ids"]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
