export type AnalyzeStatus =
  | "success"
  | "needs_clarification"
  | "low_confidence"
  | "error";

export interface SourceCitation {
  sourceId: string;
  title: string;
  excerpt: string;
  sectionRef: string;
  url?: string;
  effectiveDate?: string;
}

export interface FollowUpQuestion {
  id: string;
  question: string;
  reason: string;
}

export interface AuditEvent {
  stage: string;
  projectId: string;
  createdAt: string;
}

export interface AgentReport {
  key: "intent" | "research" | "compliance";
  label: string;
  status: "completed" | "needs_clarification" | "warning" | "skipped";
  headline: string;
  details: string[];
}

export interface FeasibilityOutput {
  decision: "likely_allowed" | "conditional" | "restricted" | "unknown";
  confidence: number;
  summary: string;
}

export interface ChecklistStep {
  order: number;
  action: string;
  requiredDocs: string[];
  department: string;
}

export interface AnalyzeResponse {
  status: AnalyzeStatus;
  traceId: string;
  agents: AgentReport[];
  feasibility: FeasibilityOutput;
  checklist: {
    steps: ChecklistStep[];
    permits: string[];
    documents: string[];
    departments: string[];
  };
  citations: SourceCitation[];
  disclaimers: string[];
  followUpQuestions: FollowUpQuestion[];
  warnings: string[];
}
