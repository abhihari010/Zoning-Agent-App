from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, HTTPException

from app.ingestion import import_source_documents
from app.models import (
    AnalysisRecord,
    AnalyzeRequest,
    FeedbackRequest,
    FeedbackRecord,
    IntakeRequest,
    IntakeResponse,
    LocalDocumentImportRequest,
    LocalDocumentImportResponse,
    ProjectRecord,
    ReindexResponse,
    SourceRegistryListResponse,
    SourceRegistryUpsertRequest,
    SessionCreateResponse,
)
from app.services import analyze_project, ensure_seed_sources, normalize_address, suggest_addresses
from app.storage import store

router = APIRouter(prefix="/api/v1")


@router.post("/sessions", response_model=SessionCreateResponse)
def create_session() -> SessionCreateResponse:
    return SessionCreateResponse(
        session_id=uuid4(),
        created_at=datetime.now(timezone.utc),
    )


@router.post("/projects/intake", response_model=IntakeResponse)
def intake_project(payload: IntakeRequest) -> IntakeResponse:
    store.audit("project.intake.received", str(payload.session_id))
    try:
        address_result = normalize_address(payload.address)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail=f"Address validation failed: {exc}") from exc

    if not address_result.is_valid:
        invalid_project_id = uuid4()
        store.audit("project.intake.invalid_address", str(invalid_project_id))
        return IntakeResponse(
            project_id=invalid_project_id,
            normalized_address=address_result.normalized_address,
            district="unknown",
            place_id=address_result.place_id,
            latitude=address_result.latitude,
            longitude=address_result.longitude,
            status="invalid_address",
            follow_up_questions=[
                "Please provide a complete street address with city.",
                *address_result.warnings,
            ],
        )

    project = ProjectRecord(
        session_id=payload.session_id,
        project_description=payload.project_description,
        input_address=payload.address,
        normalized_address=address_result.normalized_address,
        district=address_result.district,
        place_id=address_result.place_id,
        latitude=address_result.latitude,
        longitude=address_result.longitude,
    )
    store.create_project(project)
    store.audit("project.intake.validated", str(project.project_id))

    follow_up_questions = []
    if address_result.district == "unknown":
        follow_up_questions.append("Could you confirm city and postal code for address validation?")
    follow_up_questions.extend(address_result.warnings)

    return IntakeResponse(
        project_id=project.project_id,
        normalized_address=project.normalized_address,
        district=project.district,
        place_id=project.place_id,
        latitude=project.latitude,
        longitude=project.longitude,
        status="created",
        follow_up_questions=follow_up_questions,
    )


@router.get("/address/suggest")
def address_suggest(query: str, session_token: str | None = None):
    try:
        suggestions = suggest_addresses(query=query, session_token=session_token)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail=f"Address suggestions failed: {exc}") from exc

    return {"suggestions": suggestions}


@router.post("/projects/{project_id}/analyze")
def analyze(project_id: UUID, payload: AnalyzeRequest):
    if project_id != payload.project_id:
        raise HTTPException(status_code=400, detail="Path project_id must match payload project_id")

    project = store.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    store.audit("analysis.started", str(project_id))
    if payload.clarification_answers:
        store.audit("analysis.clarifications.received", str(project_id))
    result = analyze_project(
        project_description=project.project_description,
        district=project.district,
        clarification_answers=payload.clarification_answers,
    )
    store.save_analysis(AnalysisRecord(project_id=project_id, result=result))
    store.audit(f"analysis.completed.{result.status}", str(project_id))
    return result


@router.get("/projects/{project_id}/result")
def get_result(project_id: UUID):
    analysis = store.get_analysis(project_id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return analysis.result


@router.get("/projects/{project_id}/trace")
def get_trace(project_id: UUID):
    project = store.get_project(project_id)
    if not project and not store.get_analysis(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    return {"events": store.get_audit_events(project_id)}


@router.get("/ingestion/sources", response_model=SourceRegistryListResponse)
def list_sources() -> SourceRegistryListResponse:
    ensure_seed_sources()
    return SourceRegistryListResponse(sources=store.list_sources())


@router.post("/ingestion/sources", response_model=SourceRegistryListResponse)
def upsert_source(payload: SourceRegistryUpsertRequest) -> SourceRegistryListResponse:
    store.upsert_source(payload.source)
    return SourceRegistryListResponse(sources=store.list_sources())


@router.post("/ingestion/reindex", response_model=ReindexResponse)
def reindex_sources() -> ReindexResponse:
    ensure_seed_sources()
    store.audit("source.reindex.requested", "source-registry")
    return ReindexResponse(status="queued", source_count=store.get_source_count())


@router.post("/ingestion/import-local-docs", response_model=LocalDocumentImportResponse)
def import_local_docs(payload: LocalDocumentImportRequest) -> LocalDocumentImportResponse:
    try:
        entries = import_source_documents(payload.directory)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    imported_ids: list[str] = []
    for entry in entries:
        store.upsert_source(entry)
        imported_ids.append(entry.source_id)

    store.audit("source.import.completed", payload.directory or "default-documents")
    return LocalDocumentImportResponse(
        status="completed",
        imported_count=len(imported_ids),
        source_count=store.get_source_count(),
        imported_source_ids=imported_ids,
    )


@router.post("/projects/{project_id}/feedback")
def feedback(project_id: UUID, payload: FeedbackRequest):
    if payload.project_id != project_id:
        raise HTTPException(status_code=400, detail="Path project_id must match payload project_id")

    if not store.get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")

    store.audit("feedback.received", str(project_id))
    store.save_feedback(
        FeedbackRecord(
            project_id=project_id,
            helpful=payload.helpful,
            comment=payload.comment,
        )
    )
    return {"status": "accepted"}


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
