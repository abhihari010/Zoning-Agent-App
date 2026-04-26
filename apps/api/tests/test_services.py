from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app import services
from app.ingestion import import_source_documents, parse_source_file


def test_normalize_address_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "demo-key")

    place_payload = {
        "status": "OK",
        "candidates": [
            {
                "formatted_address": "300 Turner St NW, Blacksburg, VA 24060, USA",
                "place_id": "place-123",
                "address_components": [
                    {"long_name": "Downtown", "types": ["sublocality_level_1"]},
                    {"long_name": "Blacksburg", "types": ["locality"]},
                ],
                "geometry": {"location": {"lat": 40.1, "lng": -74.5}},
            }
        ],
    }

    geocode_payload = {
        "status": "OK",
        "results": [
            {
                "formatted_address": "300 Turner St NW, Blacksburg, VA 24060, USA",
                "place_id": "place-123",
                "address_components": [
                    {"long_name": "Downtown", "types": ["sublocality_level_1"]},
                    {"long_name": "Blacksburg", "types": ["locality"]},
                ],
                "geometry": {"location": {"lat": 40.1, "lng": -74.5}},
            }
        ],
    }

    class FakeResponse:
        def __init__(self, payload: dict) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return self._payload

    def fake_get(url: str, params: dict, timeout: float):
        if "findplacefromtext" in url:
            return FakeResponse(place_payload)
        return FakeResponse(geocode_payload)

    monkeypatch.setattr(services.httpx, "get", fake_get)

    result = services.normalize_address("300 Turner St NW Blacksburg")

    assert result.is_valid is True
    assert result.normalized_address == "300 Turner St NW, Blacksburg, VA 24060, USA"
    assert result.place_id == "place-123"
    assert result.latitude == 40.1
    assert result.longitude == -74.5
    assert result.district == "mixed-use-core"


def test_normalize_address_zero_results(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "demo-key")

    class FakeResponse:
        def __init__(self, payload: dict) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return self._payload

    def fake_get(url: str, params: dict, timeout: float):
        if "findplacefromtext" in url:
            return FakeResponse({"status": "ZERO_RESULTS", "candidates": []})
        return FakeResponse({"status": "ZERO_RESULTS", "results": []})

    monkeypatch.setattr(services.httpx, "get", fake_get)

    result = services.normalize_address("Unknown Place")

    assert result.is_valid is False
    assert result.district == "unknown"
    assert "could not be validated" in result.warnings[0].lower()


def test_keyword_district_rules_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_DISTRICT_KEYWORD_MAP", json.dumps({"warehouse": "industrial-zone"}))

    rules = services._load_keyword_district_rules()

    assert rules["warehouse"] == "industrial-zone"


def test_analyze_project_watsonx_success_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(services, "is_watsonx_enabled", lambda: True)
    monkeypatch.setattr(
        services,
        "retrieve_zoning_context",
        lambda **_: [
            services.SourceCitation(
                source_id="wx-1",
                title="Blacksburg Ordinance",
                excerpt="Home occupation bakeries require review in mixed-use-core.",
                section_ref="Sec 10.1",
            )
        ],
    )
    monkeypatch.setattr(
        services,
        "generate_watsonx_analysis",
        lambda **_: {
            "decision": "restricted",
            "summary": "Model indicates restrictions based on district code.",
            "required_permits": ["Special Use Permit"],
            "follow_up_questions": ["Provide parcel lot size."],
            "warnings": ["Cross-check recent amendments."],
        },
    )

    result = services.analyze_project(
        project_description="Convert garage to bakery with employees and renovation plans.",
        district="mixed-use-core",
    )

    assert result.feasibility.decision == "restricted"
    assert result.checklist.permits == ["Special Use Permit"]
    assert "Provide parcel lot size." in result.follow_up_questions


def test_analyze_project_watsonx_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(services, "is_watsonx_enabled", lambda: True)
    monkeypatch.setattr(
        services,
        "retrieve_zoning_context",
        lambda **_: [
            services.SourceCitation(
                source_id="wx-1",
                title="Blacksburg Ordinance",
                excerpt="Home occupation bakeries require review in mixed-use-core.",
                section_ref="Sec 10.1",
            )
        ],
    )

    def _raise_error(**_):
        raise RuntimeError("watsonx unavailable")

    monkeypatch.setattr(services, "generate_watsonx_analysis", _raise_error)

    result = services.analyze_project(
        project_description="Convert garage to bakery with employees and renovation plans.",
        district="mixed-use-core",
    )

    assert result.feasibility.decision in {"conditional", "likely_allowed", "unknown"}
    assert any("watsonx analysis fallback engaged" in warning for warning in result.warnings)


def test_dedupe_follow_up_questions_prefers_specific_prompt() -> None:
    deduped = services._dedupe_follow_up_questions(
        [
            "What are the proposed operating hours of the office?",
            "Please provide operating hours.",
            "What is the scope of any construction or renovations planned for the property?",
            "Please provide construction scope.",
            "Please provide number of employees.",
        ]
    )

    assert "What are the proposed operating hours of the office?" in deduped
    assert "What is the scope of any construction or renovations planned for the property?" in deduped
    assert "Please provide operating hours." not in deduped
    assert "Please provide construction scope." not in deduped
    assert "Please provide number of employees." in deduped


def test_parse_source_file_from_markdown() -> None:
    temp_dir = Path(__file__).resolve().parent / "_tmp_parse_source"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True)
    path = temp_dir / "ordinance.md"
    try:
        path.write_text(
            "\n".join(
                [
                    "title: Mixed Use Ordinance",
                    "section_ref: Sec 10.3",
                    "districts: mixed-use-core, commercial-employment",
                    "uses: general",
                    "",
                    "Mixed-use districts may allow neighborhood commercial activity with review.",
                ]
            ),
            encoding="utf-8",
        )

        entries = parse_source_file(path)

        assert len(entries) == 1
        assert entries[0].title == "Mixed Use Ordinance"
        assert entries[0].districts == ["mixed-use-core", "commercial-employment"]
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_import_source_documents_reads_multiple_formats() -> None:
    temp_dir = Path(__file__).resolve().parent / "_tmp_import_sources"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True)

    try:
        markdown_path = temp_dir / "guidance.md"
        markdown_path.write_text(
            "\n".join(
                [
                    "title: Home Occupation Rules",
                    "section_ref: Sec 1.1",
                    "districts: residential-low-density",
                    "uses: home-based-food-business",
                    "",
                    "Home occupations may be conditionally permitted when traffic remains limited.",
                ]
            ),
            encoding="utf-8",
        )

        json_path = temp_dir / "parking.json"
        json_path.write_text(
            json.dumps(
                {
                    "source_id": "parking-rule",
                    "title": "Parking Rule",
                    "excerpt": "Two spaces required.",
                    "section_ref": "Sec 2.1",
                    "districts": ["mixed-use-core"],
                    "uses": ["general"],
                }
            ),
            encoding="utf-8",
        )

        entries = import_source_documents(temp_dir)

        assert len(entries) == 2
        assert {entry.source_id for entry in entries} == {"guidance", "parking-rule"}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
