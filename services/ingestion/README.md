# Ingestion Service (Planned)

This folder is reserved for the zoning document ingestion pipeline.

Planned stages:

1. Source registration
2. Document fetch and versioning
3. Parsing and OCR fallback
4. Chunking and metadata tagging
5. Embedding and ChromaDB indexing

Current helpers:

- `python services/ingestion/seed_sources.py`
  Seeds the API's persistent source catalog from `apps/api/app/data/source_registry.json`
  or from a custom JSON file path you pass in.
- `services/ingestion/documents/`
  Local document folder for automatic ingestion. The API can now parse `.md`,
  `.txt`, and `.json` source files from this directory or from another directory
  you provide.

Document parsing format:

- `title: ...`
- `section_ref: ...`
- `url: ...`
- `effective_date: ...`
- `districts: district-a, district-b`
- `uses: use-a, use-b`

After the metadata header, the remaining body text is condensed into the source excerpt.
