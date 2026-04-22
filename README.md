# IBM Zoning App

Monorepo scaffold for a zoning feasibility assistant.

## Structure

- `apps/web`: React + TypeScript + Vite frontend with Tailwind CSS
- `apps/api`: FastAPI backend
- `packages/shared-schema`: Shared TypeScript contracts
- `services/ingestion`: Placeholder for document ingestion pipeline

## Quick Start

### Web

1. `npm install`
2. `npm run dev:web`
3. `npm run build:web`

### API

1. `cd apps/api`
2. `python -m venv .venv`
3. `.venv\\Scripts\\activate`
4. `pip install -e .[dev]`
5. From the repo root, copy `.env.example` to `.env` and fill in your credentials
6. `uvicorn app.main:app --reload --port 8000`

Set environment variables before starting the API:

- `GOOGLE_MAPS_API_KEY`: required Google Maps API key with Geocoding and Places enabled
- `GOOGLE_MAPS_TIMEOUT_SECONDS`: optional timeout (default `8`)
- `IBM_ZONING_DB_PATH`: optional SQLite database path for persistent API storage (default `apps/api/app/data/app.sqlite3`)
- `GOOGLE_DISTRICT_KEYWORD_MAP`: optional JSON mapping used when district cannot be inferred from components, example:
  - `{"downtown":"mixed-use-core","industrial":"industrial-zone"}`
- `WATSONX_ENABLED`: optional (`true` or `false`, default `false`)
- `WATSONX_API_KEY`: required when `WATSONX_ENABLED=true`
- `WATSONX_URL`: required when `WATSONX_ENABLED=true` (example `https://us-south.ml.cloud.ibm.com`)
- `WATSONX_PROJECT_ID`: required when `WATSONX_ENABLED=true`
- `WATSONX_MODEL_ID`: required when `WATSONX_ENABLED=true`
- `WATSONX_TIMEOUT_SECONDS`: optional timeout for IAM + inference (default `20`)

`.env` loading:

- The API now loads environment values automatically from:
  - repo root `.env`
  - repo root `.env.local`
  - `apps/api/.env`
  - `apps/api/.env.local`
- Recommended setup: keep a single repo-root `.env` based on `.env.example`

District and retrieval data sources:

- `apps/api/app/data/district_rules.json`: district mapping rules from Google components
- `apps/api/app/data/source_registry.json`: source registry used by zoning retrieval/citations

Available API additions:

- `GET /api/v1/address/suggest?query=...`: Google Places autocomplete-backed address suggestions
- `GET /api/v1/ingestion/sources`: list persistent source registry entries
- `POST /api/v1/ingestion/sources`: create or update a source registry entry
- `POST /api/v1/ingestion/reindex`: request source reindex
- `POST /api/v1/ingestion/import-local-docs`: parse local `.md`, `.txt`, or `.json` documents into source entries

Analysis behavior:

- If `WATSONX_ENABLED=true`, analysis attempts watsonx model inference.
- If watsonx call fails, backend falls back to deterministic analysis and records a warning.

Run backend tests:

- `cd apps/api`
- `pytest -q`

Frontend expects backend at `http://localhost:8000`.
