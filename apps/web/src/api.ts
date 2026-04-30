import type {
  AnalyzeResponse,
  AuditEvent,
  FollowUpQuestion,
} from "@ibm-zoning/shared-schema";

const DEFAULT_API_URL = import.meta.env.PROD
  ? "https://advaithmalka-zoning-agent-api.hf.space"
  : "http://localhost:8000";

const API_BASE = `${(import.meta.env.VITE_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "")}/api/v1`;

export interface IntakeResponse {
  projectId: string;
  normalizedAddress: string;
  district: string;
  placeId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  status: "created" | "invalid_address";
  followUpQuestions: FollowUpQuestion[];
}

export interface SourceRegistryEntry {
  sourceId: string;
  title: string;
  excerpt: string;
  sectionRef: string;
  url?: string | null;
  effectiveDate?: string | null;
  districts: string[];
  uses: string[];
}

export interface LocalDocumentImportResult {
  status: string;
  importedCount: number;
  sourceCount: number;
  importedSourceIds: string[];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toFollowUpQuestions(questions: string[]): FollowUpQuestion[] {
  return questions.map((question) => ({
    id: slugify(question) || crypto.randomUUID(),
    question,
    reason: "More detail improves feasibility confidence and permit guidance.",
  }));
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    return payload.detail || fallback;
  } catch {
    return fallback;
  }
}

export async function suggestAddresses(
  query: string,
  sessionToken?: string,
): Promise<string[]> {
  const params = new URLSearchParams({ query });
  if (sessionToken) {
    params.set("session_token", sessionToken);
  }

  const response = await fetch(
    `${API_BASE}/address/suggest?${params.toString()}`,
  );
  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as { suggestions: string[] };
  return payload.suggestions;
}

export async function createSession(): Promise<string> {
  const response = await fetch(`${API_BASE}/sessions`, { method: "POST" });
  if (!response.ok) {
    throw new Error(await parseError(response, "Failed to create session"));
  }
  const payload = (await response.json()) as { session_id: string };
  return payload.session_id;
}

export async function intakeProject(input: {
  session_id: string;
  project_description: string;
  address: string;
}): Promise<IntakeResponse> {
  const response = await fetch(`${API_BASE}/projects/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await parseError(response, "Project intake failed"));
  }

  const payload = (await response.json()) as {
    project_id: string;
    normalized_address: string;
    district: string;
    place_id?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    status: "created" | "invalid_address";
    follow_up_questions: string[];
  };

  return {
    projectId: payload.project_id,
    normalizedAddress: payload.normalized_address,
    district: payload.district,
    placeId: payload.place_id,
    latitude: payload.latitude,
    longitude: payload.longitude,
    status: payload.status,
    followUpQuestions: toFollowUpQuestions(payload.follow_up_questions),
  };
}

export async function analyzeProject(
  projectId: string,
  clarificationAnswers?: Record<string, string>,
): Promise<AnalyzeResponse> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      clarification_answers: clarificationAnswers ?? {},
    }),
  });

  if (!response.ok) {
    throw new Error(await parseError(response, "Analysis request failed"));
  }

  const payload = (await response.json()) as {
    status: AnalyzeResponse["status"];
    trace_id: string;
    agents: Array<{
      key: "intent" | "research" | "compliance";
      label: string;
      status: "completed" | "needs_clarification" | "warning" | "skipped";
      headline: string;
      details: string[];
    }>;
    feasibility: AnalyzeResponse["feasibility"];
    checklist: {
      steps: Array<{
        order: number;
        action: string;
        required_docs: string[];
        department: string;
      }>;
      permits: string[];
      documents: string[];
      departments: string[];
    };
    citations: Array<{
      source_id: string;
      title: string;
      excerpt: string;
      section_ref: string;
      url?: string;
      effective_date?: string;
    }>;
    disclaimers: string[];
    follow_up_questions: string[];
    warnings: string[];
  };

  return {
    status: payload.status,
    traceId: payload.trace_id,
    agents: payload.agents,
    feasibility: payload.feasibility,
    checklist: {
      ...payload.checklist,
      steps: payload.checklist.steps.map((step) => ({
        order: step.order,
        action: step.action,
        requiredDocs: step.required_docs,
        department: step.department,
      })),
    },
    citations: payload.citations.map((citation) => ({
      sourceId: citation.source_id,
      title: citation.title,
      excerpt: citation.excerpt,
      sectionRef: citation.section_ref,
      url: citation.url,
      effectiveDate: citation.effective_date,
    })),
    disclaimers: payload.disclaimers,
    followUpQuestions: toFollowUpQuestions(payload.follow_up_questions),
    warnings: payload.warnings,
  };
}

export async function fetchTrace(projectId: string): Promise<AuditEvent[]> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/trace`);
  if (!response.ok) {
    throw new Error(await parseError(response, "Failed to load trace"));
  }

  const payload = (await response.json()) as {
    events: Array<{
      stage: string;
      project_id: string;
      created_at: string;
    }>;
  };

  return payload.events.map((event) => ({
    stage: event.stage,
    projectId: event.project_id,
    createdAt: event.created_at,
  }));
}

export async function submitFeedback(input: {
  projectId: string;
  helpful: boolean;
  comment?: string;
}): Promise<void> {
  const response = await fetch(`${API_BASE}/projects/${input.projectId}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: input.projectId,
      helpful: input.helpful,
      comment: input.comment?.trim() || null,
    }),
  });

  if (!response.ok) {
    throw new Error(await parseError(response, "Feedback request failed"));
  }
}

function mapSourceEntry(payload: {
  source_id: string;
  title: string;
  excerpt: string;
  section_ref: string;
  url?: string | null;
  effective_date?: string | null;
  districts: string[];
  uses: string[];
}): SourceRegistryEntry {
  return {
    sourceId: payload.source_id,
    title: payload.title,
    excerpt: payload.excerpt,
    sectionRef: payload.section_ref,
    url: payload.url,
    effectiveDate: payload.effective_date,
    districts: payload.districts,
    uses: payload.uses,
  };
}

export async function listSources(): Promise<SourceRegistryEntry[]> {
  const response = await fetch(`${API_BASE}/ingestion/sources`);
  if (!response.ok) {
    throw new Error(await parseError(response, "Failed to load sources"));
  }

  const payload = (await response.json()) as {
    sources: Array<{
      source_id: string;
      title: string;
      excerpt: string;
      section_ref: string;
      url?: string | null;
      effective_date?: string | null;
      districts: string[];
      uses: string[];
    }>;
  };
  return payload.sources.map(mapSourceEntry);
}

export async function saveSource(
  source: SourceRegistryEntry,
): Promise<SourceRegistryEntry[]> {
  const response = await fetch(`${API_BASE}/ingestion/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: {
        source_id: source.sourceId,
        title: source.title,
        excerpt: source.excerpt,
        section_ref: source.sectionRef,
        url: source.url?.trim() || null,
        effective_date: source.effectiveDate?.trim() || null,
        districts: source.districts,
        uses: source.uses,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(await parseError(response, "Failed to save source"));
  }

  const payload = (await response.json()) as {
    sources: Array<{
      source_id: string;
      title: string;
      excerpt: string;
      section_ref: string;
      url?: string | null;
      effective_date?: string | null;
      districts: string[];
      uses: string[];
    }>;
  };
  return payload.sources.map(mapSourceEntry);
}

export async function reindexSources(): Promise<{
  status: string;
  sourceCount: number;
}> {
  const response = await fetch(`${API_BASE}/ingestion/reindex`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await parseError(response, "Failed to reindex sources"));
  }

  const payload = (await response.json()) as {
    status: string;
    source_count: number;
  };
  return { status: payload.status, sourceCount: payload.source_count };
}

export async function importLocalDocuments(
  directory?: string,
): Promise<LocalDocumentImportResult> {
  const response = await fetch(`${API_BASE}/ingestion/import-local-docs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: directory?.trim() || null }),
  });
  if (!response.ok) {
    throw new Error(await parseError(response, "Failed to import local documents"));
  }

  const payload = (await response.json()) as {
    status: string;
    imported_count: number;
    source_count: number;
    imported_source_ids: string[];
  };
  return {
    status: payload.status,
    importedCount: payload.imported_count,
    sourceCount: payload.source_count,
    importedSourceIds: payload.imported_source_ids,
  };
}
