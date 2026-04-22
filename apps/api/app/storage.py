from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from app.models import (
    AnalysisRecord,
    AuditEvent,
    FeedbackRecord,
    ProjectRecord,
    SourceRegistryEntry,
)


DEFAULT_DB_PATH = Path(__file__).resolve().parent / "data" / "app.sqlite3"


class SQLiteStore:
    def __init__(self, db_path: str | Path | None = None) -> None:
        configured_path = db_path or os.getenv("IBM_ZONING_DB_PATH") or DEFAULT_DB_PATH
        self.db_path = Path(configured_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    project_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS analyses (
                    project_id TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    helpful INTEGER NOT NULL,
                    comment TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sources (
                    source_id TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )

    def reset(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                DELETE FROM feedback;
                DELETE FROM audit_events;
                DELETE FROM analyses;
                DELETE FROM projects;
                DELETE FROM sources;
                """
            )

    def create_project(self, project: ProjectRecord) -> ProjectRecord:
        self._upsert_project(project)
        self.audit("project.created", str(project.project_id))
        return project

    def _upsert_project(self, project: ProjectRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO projects (project_id, session_id, payload_json)
                VALUES (?, ?, ?)
                """,
                (
                    str(project.project_id),
                    str(project.session_id),
                    json.dumps(project.model_dump(mode="json")),
                ),
            )

    def get_project(self, project_id: UUID) -> ProjectRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM projects WHERE project_id = ?",
                (str(project_id),),
            ).fetchone()

        if not row:
            return None
        return ProjectRecord.model_validate(json.loads(row["payload_json"]))

    def save_analysis(self, analysis: AnalysisRecord) -> AnalysisRecord:
        project = self.get_project(analysis.project_id)
        if project:
            project.status = "analyzed"
            project.updated_at = datetime.now(timezone.utc)
            self._upsert_project(project)

        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO analyses (project_id, payload_json)
                VALUES (?, ?)
                """,
                (
                    str(analysis.project_id),
                    json.dumps(analysis.model_dump(mode="json")),
                ),
            )
        self.audit("analysis.saved", str(analysis.project_id))
        return analysis

    def get_analysis(self, project_id: UUID) -> AnalysisRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM analyses WHERE project_id = ?",
                (str(project_id),),
            ).fetchone()

        if not row:
            return None
        return AnalysisRecord.model_validate(json.loads(row["payload_json"]))

    def get_audit_events(self, project_id: UUID) -> list[AuditEvent]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT stage, project_id, created_at
                FROM audit_events
                WHERE project_id = ?
                ORDER BY id ASC
                """,
                (str(project_id),),
            ).fetchall()

        return [
            AuditEvent.model_validate(dict(row))
            for row in rows
        ]

    def audit(self, stage: str, project_id: str) -> None:
        event = AuditEvent(stage=stage, project_id=project_id)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO audit_events (project_id, stage, created_at)
                VALUES (?, ?, ?)
                """,
                (event.project_id, event.stage, event.created_at.isoformat()),
            )

    def save_feedback(self, feedback: FeedbackRecord) -> FeedbackRecord:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO feedback (project_id, helpful, comment, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    str(feedback.project_id),
                    1 if feedback.helpful else 0,
                    feedback.comment,
                    feedback.created_at.isoformat(),
                ),
            )
        self.audit("feedback.saved", str(feedback.project_id))
        return feedback

    def upsert_source(self, source: SourceRegistryEntry) -> SourceRegistryEntry:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO sources (source_id, payload_json, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(source_id) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (
                    source.source_id,
                    json.dumps(source.model_dump(mode="json")),
                    now,
                    now,
                ),
            )
        self.audit("source.upserted", source.source_id)
        return source

    def list_sources(self) -> list[SourceRegistryEntry]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM sources
                ORDER BY source_id ASC
                """
            ).fetchall()

        return [
            SourceRegistryEntry.model_validate(json.loads(row["payload_json"]))
            for row in rows
        ]

    def get_source_count(self) -> int:
        with self._connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM sources").fetchone()
        return int(row["count"]) if row else 0


store = SQLiteStore()
