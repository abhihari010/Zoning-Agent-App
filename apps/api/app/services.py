from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from app.district_mapping import map_district_from_components
from app.models import AnalyzeResult, Checklist, ChecklistStep, Feasibility, SourceCitation, SourceRegistryEntry
from app.storage import store
from app.watsonx_client import generate_watsonx_analysis, is_watsonx_enabled


SOURCE_REGISTRY_PATH = Path(__file__).resolve().parent / "data" / "source_registry.json"


DISCLAIMER_TEXT = [
    "This tool provides educational zoning guidance and is not legal advice.",
    "Always verify requirements with your local planning office before action.",
]


@dataclass
class IntentExtraction:
    missing_fields: list[str]
    inferred_use: str


@dataclass
class AddressNormalizationResult:
    normalized_address: str
    district: str
    place_id: str | None
    latitude: float | None
    longitude: float | None
    is_valid: bool
    warnings: list[str]


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _load_keyword_district_rules() -> dict[str, str]:
    raw_rules = os.getenv("GOOGLE_DISTRICT_KEYWORD_MAP", "")
    if not raw_rules:
        return {
            "downtown": "mixed-use-core",
            "market": "mixed-use-core",
            "industrial": "industrial-zone",
            "business park": "commercial-employment",
            "suburb": "residential-low-density",
            "residential": "residential-low-density",
        }

    try:
        payload = json.loads(raw_rules)
        if isinstance(payload, dict):
            return {str(k).lower(): str(v) for k, v in payload.items()}
    except json.JSONDecodeError:
        pass
    return {}


def _extract_district_from_components(address_components: list[dict[str, Any]]) -> str:
    mapped = map_district_from_components(address_components)
    if mapped != "unknown":
        return mapped

    preferred_types = {"sublocality_level_1", "neighborhood"}
    for component in address_components:
        types = set(component.get("types", []))
        if preferred_types.intersection(types):
            long_name = component.get("long_name")
            if long_name:
                return f"district-{_slugify(long_name)}"
    return "unknown"


@lru_cache(maxsize=1)
def _load_seed_source_registry() -> list[dict[str, Any]]:
    if not SOURCE_REGISTRY_PATH.exists():
        return []

    with SOURCE_REGISTRY_PATH.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, list) else []


def ensure_seed_sources() -> None:
    if store.get_source_count() > 0:
        return

    for source in _load_seed_source_registry():
        try:
            entry = SourceRegistryEntry.model_validate(source)
        except Exception:
            continue
        store.upsert_source(entry)


def _district_from_keywords(normalized_address: str, rules: dict[str, str]) -> str:
    haystack = normalized_address.lower()
    for keyword, mapped in rules.items():
        if keyword in haystack:
            return mapped
    return "unknown"


def _google_find_place(address: str, api_key: str, timeout_seconds: float) -> dict[str, Any] | None:
    params = {
        "input": address,
        "inputtype": "textquery",
        "fields": "place_id,formatted_address,geometry,address_components,types,name",
        "key": api_key,
    }
    response = httpx.get(
        "https://maps.googleapis.com/maps/api/place/findplacefromtext/json",
        params=params,
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()

    status = payload.get("status")
    if status not in {"OK", "ZERO_RESULTS"}:
        raise ValueError(f"Google Places API returned status: {status}")
    if status == "ZERO_RESULTS":
        return None

    candidates = payload.get("candidates", [])
    return candidates[0] if candidates else None


def _google_geocode(address: str, api_key: str, timeout_seconds: float) -> dict[str, Any] | None:
    params = {"address": address, "key": api_key}
    response = httpx.get(
        "https://maps.googleapis.com/maps/api/geocode/json",
        params=params,
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()

    status = payload.get("status")
    if status not in {"OK", "ZERO_RESULTS"}:
        raise ValueError(f"Google Geocoding API returned status: {status}")
    if status == "ZERO_RESULTS":
        return None

    results = payload.get("results", [])
    return results[0] if results else None


def suggest_addresses(query: str, session_token: str | None = None) -> list[str]:
    trimmed = " ".join(query.split()).strip()
    if len(trimmed) < 3:
        return []

    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_MAPS_API_KEY is not configured.")

    timeout_seconds = float(os.getenv("GOOGLE_MAPS_TIMEOUT_SECONDS", "8"))
    params = {
        "input": trimmed,
        "types": "address",
        "key": api_key,
    }
    if session_token:
        params["sessiontoken"] = session_token

    response = httpx.get(
        "https://maps.googleapis.com/maps/api/place/autocomplete/json",
        params=params,
        timeout=timeout_seconds,
    )
    response.raise_for_status()

    payload = response.json()
    status = payload.get("status")
    if status not in {"OK", "ZERO_RESULTS"}:
        raise ValueError(f"Google Places Autocomplete returned status: {status}")
    if status == "ZERO_RESULTS":
        return []

    suggestions: list[str] = []
    for prediction in payload.get("predictions", []):
        description = prediction.get("description")
        if description:
            suggestions.append(str(description))
    return suggestions[:6]


def normalize_address(address: str) -> AddressNormalizationResult:
    cleaned_input = " ".join(address.split()).strip()
    if len(cleaned_input) < 5:
        return AddressNormalizationResult(
            normalized_address=cleaned_input,
            district="unknown",
            place_id=None,
            latitude=None,
            longitude=None,
            is_valid=False,
            warnings=["Address appears incomplete."],
        )

    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_MAPS_API_KEY is not configured.")

    timeout_seconds = float(os.getenv("GOOGLE_MAPS_TIMEOUT_SECONDS", "8"))
    keyword_rules = _load_keyword_district_rules()

    place_candidate = _google_find_place(cleaned_input, api_key, timeout_seconds)
    geocode_result = _google_geocode(cleaned_input, api_key, timeout_seconds)

    if not place_candidate and not geocode_result:
        return AddressNormalizationResult(
            normalized_address=cleaned_input,
            district="unknown",
            place_id=None,
            latitude=None,
            longitude=None,
            is_valid=False,
            warnings=["Address could not be validated with Google Maps APIs."],
        )

    formatted_address = (
        (place_candidate or {}).get("formatted_address")
        or (geocode_result or {}).get("formatted_address")
        or cleaned_input
    )
    place_id = (place_candidate or {}).get("place_id") or (geocode_result or {}).get("place_id")

    geometry = (place_candidate or {}).get("geometry") or (geocode_result or {}).get("geometry") or {}
    location = geometry.get("location", {})
    lat = location.get("lat")
    lng = location.get("lng")

    address_components = (
        (place_candidate or {}).get("address_components")
        or (geocode_result or {}).get("address_components")
        or []
    )

    district = _extract_district_from_components(address_components)
    if district == "unknown":
        district = _district_from_keywords(formatted_address, keyword_rules)

    warnings: list[str] = []
    if district == "unknown":
        warnings.append("District could not be inferred from returned location context.")

    return AddressNormalizationResult(
        normalized_address=formatted_address,
        district=district,
        place_id=place_id,
        latitude=float(lat) if isinstance(lat, (float, int)) else None,
        longitude=float(lng) if isinstance(lng, (float, int)) else None,
        is_valid=True,
        warnings=warnings,
    )


def extract_intent(project_description: str) -> IntentExtraction:
    lower = project_description.lower()
    missing_fields: list[str] = []
    inferred_use = "general"

    if "garage" in lower and "bakery" in lower:
        inferred_use = "home-based-food-business"

    if "hours" not in lower:
        missing_fields.append("operating hours")
    if "employees" not in lower:
        missing_fields.append("number of employees")
    if "renovation" not in lower and "construction" not in lower:
        missing_fields.append("construction scope")

    return IntentExtraction(missing_fields=missing_fields, inferred_use=inferred_use)


def retrieve_zoning_context(district: str, inferred_use: str) -> list[SourceCitation]:
    ensure_seed_sources()
    hits: list[SourceCitation] = []
    for source in store.list_sources():
        districts = source.districts
        uses = source.uses

        district_ok = district in districts or "*" in districts or district == "unknown"
        use_ok = inferred_use in uses or "general" in uses
        if not district_ok or not use_ok:
            continue

        hits.append(
            SourceCitation(
                source_id=source.source_id,
                title=source.title,
                excerpt=source.excerpt,
                section_ref=source.section_ref,
                url=source.url,
                effective_date=source.effective_date,
            )
        )

    if not hits:
        return [
            SourceCitation(
                source_id="fallback-guidance",
                title="Fallback Guidance",
                excerpt="No matching zoning references were found for the selected district and use.",
                section_ref="N/A",
            )
        ]

    return hits[:5]


def _confidence_score(missing_fields: list[str], citations: list[SourceCitation]) -> float:
    base = 0.82
    coverage_penalty = min(0.35, 0.07 * len(missing_fields))
    citation_bonus = min(0.15, 0.05 * len(citations))
    score = base - coverage_penalty + citation_bonus
    return max(0.1, min(0.98, score))


def _deterministic_feasibility(project_description: str, district: str) -> tuple[str, str]:
    if district == "unknown":
        return "unknown", "District could not be confidently mapped. Additional parcel verification is required."
    if "bakery" in project_description.lower() and "garage" in project_description.lower():
        return (
            "conditional",
            "Garage-to-bakery conversion appears conditionally feasible with fire, health, and parking approvals.",
        )
    return "likely_allowed", "Proposed use appears likely allowed, subject to standard permit review."


def analyze_project(project_description: str, district: str) -> AnalyzeResult:
    intent = extract_intent(project_description)
    citations = retrieve_zoning_context(district=district, inferred_use=intent.inferred_use)
    confidence = _confidence_score(intent.missing_fields, citations)

    decision, summary = _deterministic_feasibility(project_description, district)

    status = "success"
    warnings: list[str] = []
    follow_up: list[str] = []
    permits_override: list[str] = []

    if is_watsonx_enabled():
        try:
            model_output = generate_watsonx_analysis(
                project_description=project_description,
                district=district,
                citation_excerpts=[citation.excerpt for citation in citations],
                missing_fields=intent.missing_fields,
            )
            model_decision = str(model_output.get("decision", decision))
            if model_decision in {"likely_allowed", "conditional", "restricted", "unknown"}:
                decision = model_decision
            summary = str(model_output.get("summary", summary))
            permits_override = [str(item) for item in model_output.get("required_permits", [])]
            follow_up.extend([str(item) for item in model_output.get("follow_up_questions", [])])
            warnings.extend([str(item) for item in model_output.get("warnings", [])])
        except Exception as exc:
            warnings.append(f"watsonx fallback engaged: {exc}")

    if intent.missing_fields:
        status = "needs_clarification"
        follow_up.extend([f"Please provide {field}." for field in intent.missing_fields])

    if confidence < 0.6:
        status = "low_confidence"
        warnings.append("Confidence is low due to incomplete evidence or conflicting context.")

    checklist_steps = [
        ChecklistStep(
            order=1,
            action="Request zoning verification letter for the parcel",
            required_docs=["site plan", "property ownership proof"],
            department="Planning Department",
        ),
        ChecklistStep(
            order=2,
            action="Submit change-of-use permit application",
            required_docs=["business description", "floor plan", "parking plan"],
            department="Permit Office",
        ),
        ChecklistStep(
            order=3,
            action="Complete fire and health compliance inspections",
            required_docs=["equipment specification", "ventilation design"],
            department="Fire Marshal and Health Department",
        ),
    ]

    checklist = Checklist(
        steps=checklist_steps,
        permits=permits_override or ["Change-of-Use Permit", "Business License", "Health Permit"],
        documents=["Site Plan", "Floor Plan", "Parking Plan", "Fire Safety Plan"],
        departments=["Planning", "Permitting", "Fire", "Health"],
    )

    deduped_follow_up = list(dict.fromkeys(follow_up))

    return AnalyzeResult(
        status=status,
        trace_id=f"trace-{uuid4()}",
        feasibility=Feasibility(decision=decision, confidence=confidence, summary=summary),
        checklist=checklist,
        citations=citations,
        disclaimers=DISCLAIMER_TEXT,
        follow_up_questions=deduped_follow_up,
        warnings=warnings,
    )
