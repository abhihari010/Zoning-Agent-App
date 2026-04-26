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
from app.models import (
    AgentReport,
    AnalyzeResult,
    Checklist,
    ChecklistStep,
    Feasibility,
    SourceCitation,
    SourceRegistryEntry,
)
from app.storage import store
from app.watsonx_client import generate_watsonx_analysis, is_watsonx_enabled, search_ordinances


SOURCE_REGISTRY_PATH = Path(__file__).resolve().parent / "data" / "source_registry.json"


DISCLAIMER_TEXT = [
    "This tool provides educational zoning guidance and is not legal advice.",
    "Always verify requirements with your local planning office before action.",
]


@dataclass
class IntentExtraction:
    missing_fields: list[str]
    inferred_use: str
    user_intent: str
    project_category: str


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
        "fields": "place_id,formatted_address,geometry,name",
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
    # Bias toward Blacksburg, VA (37.2296, -80.4139) within a 6 km radius
    params = {
        "input": trimmed,
        "types": "address",
        "location": "37.2296,-80.4139",
        "radius": "6000",
        "strictbounds": "true",
        "components": "country:US",
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

    # Restrict to Blacksburg, VA only
    address_upper = formatted_address.upper()
    if "BLACKSBURG" not in address_upper or (
        ", VA " not in formatted_address and ", Virginia" not in formatted_address
    ):
        return AddressNormalizationResult(
            normalized_address=formatted_address,
            district="unknown",
            place_id=None,
            latitude=None,
            longitude=None,
            is_valid=False,
            warnings=["This tool only supports addresses in Blacksburg, VA."],
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
    user_intent = "review whether the proposed project is allowed on the property"
    project_category = "general-project"

    if "garage" in lower and "bakery" in lower:
        inferred_use = "home-based-food-business"
        user_intent = "open a bakery from an attached garage conversion"
        project_category = "home-business"
    elif "bakery" in lower:
        inferred_use = "food-business"
        user_intent = "open a bakery on the property"
        project_category = "business-opening"
    elif "restaurant" in lower or "cafe" in lower:
        inferred_use = "food-service"
        user_intent = "open a food service business on the property"
        project_category = "business-opening"
    elif "addition" in lower or "build" in lower or "construction" in lower:
        user_intent = "confirm whether the proposed construction is allowed"
        project_category = "construction"

    if "hours" not in lower:
        missing_fields.append("operating hours")
    if "employees" not in lower:
        missing_fields.append("number of employees")
    if "renovation" not in lower and "construction" not in lower:
        missing_fields.append("construction scope")

    if len(lower.split()) < 8:
        missing_fields.insert(0, "project scope and intended use")

    return IntentExtraction(
        missing_fields=list(dict.fromkeys(missing_fields)),
        inferred_use=inferred_use,
        user_intent=user_intent,
        project_category=project_category,
    )


def retrieve_zoning_context(
    district: str,
    inferred_use: str,
    project_description: str = "",
) -> list[SourceCitation]:
    if is_watsonx_enabled():
        query = f"{inferred_use} {district} {project_description}".strip()
        passages = search_ordinances(query)
        citations: list[SourceCitation] = []
        for i, passage in enumerate(passages[:5]):
            text = passage.get("text") or passage.get("content") or passage.get("excerpt") or str(passage)
            title = passage.get("title") or passage.get("document_title") or "Blacksburg Code of Ordinances"
            section = passage.get("section_ref") or passage.get("section") or passage.get("chunk_id") or f"Sec {i + 1}"
            source_id = passage.get("source_id") or passage.get("id") or f"blacksburg-ordinance-{i + 1}"
            url = passage.get("url") or None
            citations.append(
                SourceCitation(
                    source_id=str(source_id),
                    title=str(title),
                    excerpt=str(text),
                    section_ref=str(section),
                    url=url,
                )
            )
        return citations

    ensure_seed_sources()
    hits: list[SourceCitation] = []
    for source in store.list_sources():
        district_ok = district in source.districts or "*" in source.districts or district == "unknown"
        use_ok = inferred_use in source.uses or "general" in source.uses
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
    return hits[:5]


def _confidence_score(missing_fields: list[str], citations: list[SourceCitation]) -> float:
    base = 0.82
    coverage_penalty = min(0.35, 0.07 * len(missing_fields))
    citation_bonus = min(0.15, 0.05 * len(citations))
    retrieval_penalty = 0.28 if not citations else 0
    score = base - coverage_penalty + citation_bonus
    score -= retrieval_penalty
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


def _merge_project_context(
    project_description: str,
    clarification_answers: dict[str, str] | None = None,
) -> str:
    answers = clarification_answers or {}
    usable_answers = [(question.strip(), answer.strip()) for question, answer in answers.items() if answer.strip()]
    if not usable_answers:
        return project_description

    clarification_lines = "\n".join(f"- {question}: {answer}" for question, answer in usable_answers)
    return f"{project_description}\n\nClarifications:\n{clarification_lines}"


def _normalize_follow_up_key(question: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", question.lower()).strip()
    tokens = set(normalized.split())

    if "hours" in tokens:
        return "operating hours"
    if "employee" in tokens or "employees" in tokens or "workers" in tokens:
        return "number of employees"
    if ("construction" in tokens or "renovation" in tokens or "renovations" in tokens) and (
        "scope" in tokens or "planned" in tokens or "modifications" in tokens
    ):
        return "construction scope"
    if "noise" in tokens or ("surrounding" in tokens and "residential" in tokens):
        return "noise and neighborhood impact"
    if "parking" in tokens:
        return "parking"
    if "lot" in tokens and "size" in tokens:
        return "lot size"
    return normalized


def _dedupe_follow_up_questions(questions: list[str]) -> list[str]:
    best_by_key: dict[str, str] = {}

    for question in questions:
        cleaned = " ".join(question.split()).strip()
        if not cleaned:
            continue

        key = _normalize_follow_up_key(cleaned)
        existing = best_by_key.get(key)
        if existing is None:
            best_by_key[key] = cleaned
            continue

        existing_generic = existing.lower().startswith("please provide ")
        cleaned_generic = cleaned.lower().startswith("please provide ")
        if existing_generic and not cleaned_generic:
            best_by_key[key] = cleaned

    ordered: list[str] = []
    seen: set[str] = set()
    for question in questions:
        cleaned = " ".join(question.split()).strip()
        if not cleaned:
            continue
        key = _normalize_follow_up_key(cleaned)
        chosen = best_by_key[key]
        if chosen not in seen:
            ordered.append(chosen)
            seen.add(chosen)
    return ordered


def analyze_project(
    project_description: str,
    district: str,
    clarification_answers: dict[str, str] | None = None,
) -> AnalyzeResult:
    combined_description = _merge_project_context(project_description, clarification_answers)
    intent = extract_intent(combined_description)
    watsonx_active = is_watsonx_enabled()
    retrieval_error: str | None = None
    try:
        citations = retrieve_zoning_context(
            district=district,
            inferred_use=intent.inferred_use,
            project_description=combined_description,
        )
    except Exception as exc:
        citations = []
        retrieval_error = str(exc)

    confidence = _confidence_score(intent.missing_fields, citations)

    decision, summary = _deterministic_feasibility(combined_description, district)
    if watsonx_active:
        decision = "unknown"
        summary = (
            "Waiting on watsonx ordinance retrieval and compliance reasoning before making a zoning call."
        )

    status = "success"
    warnings: list[str] = []
    follow_up: list[str] = []
    permits_override: list[str] = []
    agent_reports: list[AgentReport] = [
        AgentReport(
            key="intent",
            label="User Intent Agent",
            status="completed",
            headline=f"Captured a {intent.project_category} request to {intent.user_intent}.",
            details=[
                f"Project category: {intent.project_category}",
                f"Inferred use: {intent.inferred_use}",
                f"District context: {district}",
            ],
        )
    ]

    if retrieval_error:
        if watsonx_active:
            warnings.append(f"watsonx retrieval failed: {retrieval_error}")
        else:
            warnings.append(f"Local source retrieval failed: {retrieval_error}")

    if watsonx_active:
        try:
            model_output = generate_watsonx_analysis(
                project_description=combined_description,
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
            warnings.append(f"watsonx analysis fallback engaged: {exc}")
            decision, summary = _deterministic_feasibility(combined_description, district)

    if citations:
        agent_reports.append(
            AgentReport(
                key="research",
                label="Zoning Research Agent",
                status="completed",
                headline=(
                    f"Retrieved {len(citations)} ordinance passages from the watsonx knowledge index."
                    if watsonx_active
                    else f"Retrieved {len(citations)} relevant zoning source excerpts for review."
                ),
                details=[
                    f"District searched: {district}",
                    f"Use searched: {intent.inferred_use}",
                    *[f"{citation.title} ({citation.section_ref})" for citation in citations[:3]],
                ],
            )
        )
    else:
        agent_reports.append(
            AgentReport(
                key="research",
                label="Zoning Research Agent",
                status="warning",
                headline=(
                    "watsonx retrieval did not return matching Blacksburg ordinance passages for this request."
                    if watsonx_active
                    else "No relevant municipal ordinances were found in the current source registry."
                ),
                details=[
                    (
                        "The watsonx ordinance index did not return enough zoning text for this district and use."
                        if watsonx_active
                        else "The system could not retrieve matching zoning text for this district and use."
                    ),
                    "A human review with the planning department is recommended before acting.",
                ],
            )
        )
        decision = "unknown"
        summary = (
            "We could not find enough source material for this district and project type to make a reliable zoning call."
        )
        warnings.append(
            (
                "No relevant ordinances were returned by watsonx retrieval for this request. Please contact the planning office."
                if watsonx_active
                else "No relevant ordinances were found in the current zoning source registry. Please contact the planning office."
            )
        )

    if intent.missing_fields:
        status = "needs_clarification"
        follow_up.extend([f"Please provide {field}." for field in intent.missing_fields])
        agent_reports[0].status = "needs_clarification"
        agent_reports[0].headline = "The project brief needs a few more details before the zoning call is reliable."
        agent_reports[0].details.extend([f"Missing: {field}" for field in intent.missing_fields])

    if confidence < 0.6 or not citations or district == "unknown":
        if status != "needs_clarification":
            status = "low_confidence"
        warnings.append("Confidence is low due to incomplete evidence or conflicting context.")
        warnings.append("Human-in-the-loop fallback: verify the parcel directly with the zoning or planning office.")

    if not citations:
        checklist_steps = [
            ChecklistStep(
                order=1,
                action="Contact the planning department for parcel-level zoning verification",
                required_docs=["property address", "parcel number if available", "project description"],
                department="Planning Department",
            ),
            ChecklistStep(
                order=2,
                action="Request the current zoning district, permitted use table, and recent amendments",
                required_docs=["written zoning inquiry", "site sketch if available"],
                department="Planning Department",
            ),
            ChecklistStep(
                order=3,
                action="Confirm permit sequencing before spending on design or construction",
                required_docs=["draft floor plan", "business operations summary"],
                department="Permit Office",
            ),
        ]
    else:
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
        permits=permits_override
        or (
            ["Zoning Verification Request", "Planning Counter Review"]
            if not citations
            else ["Change-of-Use Permit", "Business License", "Health Permit"]
        ),
        documents=(
            ["Property Address", "Project Narrative", "Parcel Number", "Site Sketch"]
            if not citations
            else ["Site Plan", "Floor Plan", "Parking Plan", "Fire Safety Plan"]
        ),
        departments=["Planning", "Permitting", "Fire", "Health"] if citations else ["Planning", "Permitting"],
    )

    deduped_follow_up = _dedupe_follow_up_questions(follow_up)
    agent_reports.append(
        AgentReport(
            key="compliance",
            label="Compliance & Checklist Agent",
            status="warning" if status == "low_confidence" else ("needs_clarification" if status == "needs_clarification" else "completed"),
            headline=summary,
            details=[
                f"Decision: {decision}",
                f"Confidence: {confidence:.2f}",
                f"Checklist steps: {len(checklist.steps)}",
            ],
        )
    )

    return AnalyzeResult(
        status=status,
        trace_id=f"trace-{uuid4()}",
        agents=agent_reports,
        feasibility=Feasibility(decision=decision, confidence=confidence, summary=summary),
        checklist=checklist,
        citations=citations,
        disclaimers=DISCLAIMER_TEXT,
        follow_up_questions=deduped_follow_up,
        warnings=warnings,
    )
