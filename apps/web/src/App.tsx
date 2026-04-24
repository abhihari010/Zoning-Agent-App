import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  AgentReport,
  AnalyzeResponse,
  AuditEvent,
  FollowUpQuestion,
} from "@ibm-zoning/shared-schema";
import {
  analyzeProject,
  createSession,
  fetchTrace,
  importLocalDocuments,
  intakeProject,
  listSources,
  reindexSources,
  saveSource,
  suggestAddresses,
  submitFeedback,
  type IntakeResponse,
  type SourceRegistryEntry,
} from "./api";

const DISCLAIMER =
  "Educational guidance only. Zoning rules, permit triggers, and code interpretations must be verified with the official planning department before you rely on this result.";

type Workspace = "assistant" | "admin";
type Phase = "idle" | "intake" | "analyzing" | "done" | "error";
type FeedbackState = "idle" | "submitting" | "submitted";

function emptySourceForm(): SourceRegistryEntry {
  return {
    sourceId: "",
    title: "",
    excerpt: "",
    sectionRef: "",
    url: "",
    effectiveDate: "",
    districts: [],
    uses: [],
  };
}

function parseTagList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function decisionLabel(decision: AnalyzeResponse["feasibility"]["decision"]): string {
  switch (decision) {
    case "likely_allowed":
      return "Allowed";
    case "conditional":
      return "Conditional";
    case "restricted":
      return "Not Allowed";
    default:
      return "Unknown";
  }
}

function decisionTone(decision: AnalyzeResponse["feasibility"]["decision"]): string {
  switch (decision) {
    case "likely_allowed":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "conditional":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "restricted":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-800";
  }
}

function statusTone(status: AgentReport["status"], isActive: boolean): string {
  if (isActive) {
    return "border-clay bg-clay/10";
  }
  if (status === "completed") {
    return "border-emerald-200 bg-emerald-50";
  }
  if (status === "warning") {
    return "border-amber-200 bg-amber-50";
  }
  if (status === "needs_clarification") {
    return "border-clay/40 bg-clay/10";
  }
  return "border-slate-200 bg-white";
}

function buildChecklistDownload(
  intake: IntakeResponse | null,
  result: AnalyzeResponse,
  projectDescription: string,
): string {
  return [
    "IBMinds Zoning Agent Checklist",
    "",
    `Project: ${projectDescription.trim()}`,
    `Address: ${intake?.normalizedAddress ?? "Not available"}`,
    `District: ${intake?.district ?? "Unknown"}`,
    `Verdict: ${decisionLabel(result.feasibility.decision)}`,
    `Confidence: ${(result.feasibility.confidence * 100).toFixed(0)}%`,
    "",
    "Summary",
    result.feasibility.summary,
    "",
    "Permits",
    ...result.checklist.permits.map((permit) => `- ${permit}`),
    "",
    "Checklist",
    ...result.checklist.steps.map(
      (step) =>
        `${step.order}. ${step.action} | ${step.department} | Documents: ${step.requiredDocs.join(", ")}`,
    ),
    "",
    "Sources",
    ...result.citations.map((citation) => `- ${citation.title} (${citation.sectionRef})`),
    "",
    "Disclaimers",
    ...result.disclaimers.map((disclaimer) => `- ${disclaimer}`),
  ].join("\n");
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace>("assistant");
  const [acceptedDisclaimer, setAcceptedDisclaimer] = useState(false);
  const [projectDescription, setProjectDescription] = useState("");
  const [address, setAddress] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [autocompleteSession] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<Phase>("idle");
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [intake, setIntake] = useState<IntakeResponse | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [trace, setTrace] = useState<AuditEvent[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackState, setFeedbackState] = useState<FeedbackState>("idle");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [clarificationOpen, setClarificationOpen] = useState(false);
  const [clarificationQuestions, setClarificationQuestions] = useState<FollowUpQuestion[]>([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({});
  const [clarificationSubmitting, setClarificationSubmitting] = useState(false);
  const [sources, setSources] = useState<SourceRegistryEntry[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourceForm, setSourceForm] = useState<SourceRegistryEntry>(emptySourceForm);
  const [sourceMessage, setSourceMessage] = useState("");
  const [sourceSaving, setSourceSaving] = useState(false);
  const [reindexMessage, setReindexMessage] = useState("");
  const [importDirectory, setImportDirectory] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const addressSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const trimmed = address.trim();
    if (trimmed.length < 3) {
      setSuggestions([]);
      setActiveSuggestionIndex(-1);
      return;
    }

    const handle = setTimeout(async () => {
      try {
        setSuggestionLoading(true);
        const options = await suggestAddresses(trimmed, autocompleteSession);
        setSuggestions(options);
        setActiveSuggestionIndex(options.length > 0 ? 0 : -1);
      } finally {
        setSuggestionLoading(false);
      }
    }, 200);

    return () => clearTimeout(handle);
  }, [address, autocompleteSession]);

  useEffect(() => {
    const onDocumentPointerDown = (event: MouseEvent) => {
      const container = addressSectionRef.current;
      if (container && !container.contains(event.target as Node)) {
        setSuggestions([]);
        setActiveSuggestionIndex(-1);
      }
    };

    document.addEventListener("mousedown", onDocumentPointerDown);
    return () => document.removeEventListener("mousedown", onDocumentPointerDown);
  }, []);

  useEffect(() => {
    if (phase !== "analyzing") {
      return;
    }

    const interval = window.setInterval(() => {
      setActiveAgentIndex((current) => (current + 1) % 3);
    }, 1200);

    return () => window.clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (!intake || intake.status !== "created") {
      setTrace([]);
      return;
    }

    const projectId = intake.projectId;
    let cancelled = false;

    async function loadTrace() {
      try {
        setTraceLoading(true);
        const events = await fetchTrace(projectId);
        if (!cancelled) {
          setTrace(events);
        }
      } catch {
        if (!cancelled) {
          setTrace([]);
        }
      } finally {
        if (!cancelled) {
          setTraceLoading(false);
        }
      }
    }

    void loadTrace();
    return () => {
      cancelled = true;
    };
  }, [intake, result, phase]);

  useEffect(() => {
    let cancelled = false;

    async function loadSources() {
      try {
        setSourcesLoading(true);
        const nextSources = await listSources();
        if (!cancelled) {
          setSources(nextSources);
        }
      } catch (loadError) {
        if (!cancelled) {
          setSourceMessage(
            loadError instanceof Error ? loadError.message : "Failed to load sources.",
          );
        }
      } finally {
        if (!cancelled) {
          setSourcesLoading(false);
        }
      }
    }

    void loadSources();
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = useMemo(
    () =>
      acceptedDisclaimer &&
      projectDescription.trim().length >= 10 &&
      address.trim().length >= 5,
    [acceptedDisclaimer, projectDescription, address],
  );

  const displayedAgents = useMemo(() => {
    const loadingAgents: AgentReport[] = [
      {
        key: "intent",
        label: "Understanding Request",
        status: "completed",
        headline: "Interpreting the project, use type, and missing details.",
        details: ["Extracting the project goal from plain English."],
      },
      {
        key: "research",
        label: "Retrieving Zoning Codes",
        status: "completed",
        headline: "Looking up district rules, permit triggers, and ordinance excerpts.",
        details: ["Searching the municipal source registry."],
      },
      {
        key: "compliance",
        label: "Drafting Checklist",
        status: "completed",
        headline: "Turning the zoning evidence into a permit path and plain-language answer.",
        details: ["Producing the feasibility summary and next steps."],
      },
    ];

    return result?.agents.length ? result.agents : loadingAgents;
  }, [result]);

  const assistantPrompts = useMemo(() => {
    const prompts: string[] = [];
    if (intake) {
      prompts.push(...intake.followUpQuestions.map((question) => question.question));
    }
    if (result) {
      prompts.push(...result.followUpQuestions.map((question) => question.question));
      prompts.push(...result.warnings);
    }
    return Array.from(new Set(prompts));
  }, [intake, result]);

  function selectSuggestion(option: string) {
    setAddress(option);
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
  }

  function onAddressKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestionIndex((current) => (current + 1) % suggestions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestionIndex((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === "Enter" && activeSuggestionIndex >= 0) {
      event.preventDefault();
      selectSuggestion(suggestions[activeSuggestionIndex]);
      return;
    }

    if (event.key === "Escape") {
      setSuggestions([]);
      setActiveSuggestionIndex(-1);
    }
  }

  async function refreshSources(message?: string) {
    const nextSources = await listSources();
    setSources(nextSources);
    if (message) {
      setSourceMessage(message);
    }
  }

  async function runAnalysis(projectId: string, answers?: Record<string, string>) {
    setPhase("analyzing");
    setActiveAgentIndex(0);
    const analysis = await analyzeProject(projectId, answers);
    setResult(analysis);
    setPhase("done");

    if (analysis.status === "needs_clarification" && analysis.followUpQuestions.length > 0) {
      const nextAnswers = analysis.followUpQuestions.reduce<Record<string, string>>(
        (accumulator, question) => {
          accumulator[question.question] = clarificationAnswers[question.question] ?? "";
          return accumulator;
        },
        {},
      );
      setClarificationQuestions(analysis.followUpQuestions);
      setClarificationAnswers(nextAnswers);
      setClarificationOpen(true);
    }
  }

  async function onSubmit() {
    if (!canSubmit) {
      return;
    }

    setError(null);
    setResult(null);
    setIntake(null);
    setTrace([]);
    setFeedbackNote("");
    setFeedbackState("idle");
    setFeedbackMessage("");
    setClarificationOpen(false);
    setClarificationQuestions([]);
    setClarificationAnswers({});

    try {
      setPhase("intake");
      const sessionId = await createSession();
      const intakeResult = await intakeProject({
        session_id: sessionId,
        project_description: projectDescription.trim(),
        address: address.trim(),
      });
      setIntake(intakeResult);

      if (intakeResult.status !== "created") {
        setPhase("error");
        setError(
          "We need a more complete property address before the zoning agents can continue.",
        );
        return;
      }

      await runAnalysis(intakeResult.projectId);
    } catch (submitError) {
      setPhase("error");
      setError(
        submitError instanceof Error ? submitError.message : "Something went wrong during analysis.",
      );
    }
  }

  async function onSubmitClarifications() {
    if (!intake) {
      return;
    }

    const unanswered = clarificationQuestions.some(
      (question) => !clarificationAnswers[question.question]?.trim(),
    );
    if (unanswered) {
      setError("Please answer each clarification so we can continue the review.");
      return;
    }

    try {
      setError(null);
      setClarificationSubmitting(true);
      setClarificationOpen(false);
      await runAnalysis(intake.projectId, clarificationAnswers);
    } catch (clarificationError) {
      setPhase("error");
      setError(
        clarificationError instanceof Error
          ? clarificationError.message
          : "Clarification request failed.",
      );
    } finally {
      setClarificationSubmitting(false);
    }
  }

  async function onSubmitFeedback(helpful: boolean) {
    if (!intake || feedbackState === "submitting") {
      return;
    }

    try {
      setFeedbackState("submitting");
      await submitFeedback({
        projectId: intake.projectId,
        helpful,
        comment: feedbackNote,
      });
      setFeedbackState("submitted");
      setFeedbackMessage(
        helpful
          ? "Thanks. That tells us the workflow is landing in the right place."
          : "Thanks. We’ll treat that as a signal to tighten the workflow.",
      );
    } catch (feedbackError) {
      setFeedbackState("idle");
      setFeedbackMessage(
        feedbackError instanceof Error
          ? feedbackError.message
          : "Feedback submission failed.",
      );
    }
  }

  function downloadChecklist() {
    if (!result) {
      return;
    }

    const blob = new Blob([buildChecklistDownload(intake, result, projectDescription)], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "zoning-checklist.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function onSaveSource() {
    if (
      !sourceForm.sourceId.trim() ||
      !sourceForm.title.trim() ||
      !sourceForm.excerpt.trim() ||
      !sourceForm.sectionRef.trim()
    ) {
      setSourceMessage("Source ID, title, excerpt, and section reference are required.");
      return;
    }

    try {
      setSourceSaving(true);
      setSourceMessage("");
      const saved = await saveSource({
        ...sourceForm,
        sourceId: sourceForm.sourceId.trim(),
        title: sourceForm.title.trim(),
        excerpt: sourceForm.excerpt.trim(),
        sectionRef: sourceForm.sectionRef.trim(),
      });
      setSources(saved);
      setSourceForm(emptySourceForm());
      setSourceMessage("Source saved.");
    } catch (saveError) {
      setSourceMessage(
        saveError instanceof Error ? saveError.message : "Failed to save source.",
      );
    } finally {
      setSourceSaving(false);
    }
  }

  async function onReindexSources() {
    try {
      setReindexMessage("");
      const summary = await reindexSources();
      setReindexMessage(
        `Reindex ${summary.status}. ${summary.sourceCount} sources are currently registered.`,
      );
      await refreshSources();
    } catch (reindexError) {
      setReindexMessage(
        reindexError instanceof Error
          ? reindexError.message
          : "Failed to request reindex.",
      );
    }
  }

  async function onImportDocuments() {
    try {
      setImporting(true);
      setImportMessage("");
      const importResult = await importLocalDocuments(importDirectory);
      await refreshSources(
        `Imported ${importResult.importedCount} document(s). ${importResult.sourceCount} sources now available.`,
      );
      setImportMessage(
        importResult.importedSourceIds.length > 0
          ? `Imported: ${importResult.importedSourceIds.join(", ")}`
          : "No documents were imported.",
      );
    } catch (importError) {
      setImportMessage(
        importError instanceof Error
          ? importError.message
          : "Failed to import local documents.",
      );
    } finally {
      setImporting(false);
    }
  }

  function loadSourceIntoForm(source: SourceRegistryEntry) {
    setWorkspace("admin");
    setSourceForm(source);
    setSourceMessage(`Loaded ${source.sourceId} into the editor.`);
  }

  function resetWorkspace() {
    setAcceptedDisclaimer(false);
    setProjectDescription("");
    setAddress("");
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setPhase("idle");
    setError(null);
    setIntake(null);
    setResult(null);
    setTrace([]);
    setFeedbackNote("");
    setFeedbackState("idle");
    setFeedbackMessage("");
    setClarificationOpen(false);
    setClarificationQuestions([]);
    setClarificationAnswers({});
  }

  const showHumanFallback =
    result?.status === "low_confidence" || result?.feasibility.decision === "unknown";

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#f7f1e6_0%,#efe4d3_100%)] text-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
        <section className="mb-6 grid gap-4 rounded-[28px] border border-pine/10 bg-white/85 p-5 shadow-card backdrop-blur lg:grid-cols-[1.4fr_0.6fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">
              IBMinds Zoning Agent
            </p>
            <h1 className="mt-3 font-heading text-3xl leading-tight text-pine md:text-4xl">
              Check whether a project is allowed on a property and get the next permit steps.
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700 md:text-base">
              This workspace runs a three-agent zoning review: one agent interprets the request,
              one retrieves municipal code evidence, and one turns that into a feasibility summary
              plus a permit checklist.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
              {DISCLAIMER}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setWorkspace("assistant")}
                className={`flex-1 rounded-2xl px-4 py-3 text-sm font-semibold ${
                  workspace === "assistant"
                    ? "bg-pine text-white"
                    : "border border-slate-300 bg-white text-slate-700"
                }`}
              >
                Assistant
              </button>
              <button
                type="button"
                onClick={() => setWorkspace("admin")}
                className={`flex-1 rounded-2xl px-4 py-3 text-sm font-semibold ${
                  workspace === "admin"
                    ? "bg-clay text-white"
                    : "border border-slate-300 bg-white text-slate-700"
                }`}
              >
                Source Admin
              </button>
            </div>
          </div>
        </section>

        {workspace === "assistant" ? (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_360px]">
            <section className="space-y-6">
              <div className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                <div className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-slate-700">
                  <input
                    className="mt-1 h-4 w-4 accent-clay"
                    type="checkbox"
                    checked={acceptedDisclaimer}
                    onChange={(event) => setAcceptedDisclaimer(event.target.checked)}
                  />
                  <span>I understand this is an educational tool and not official legal approval.</span>
                </div>

                <label className="mb-4 block text-sm font-semibold text-slate-700">
                  Describe the project
                  <textarea
                    className="mt-2 min-h-[180px] w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                    value={projectDescription}
                    onChange={(event) => setProjectDescription(event.target.value)}
                    placeholder="Example: Can I open a bakery out of my attached garage with two employees, weekday pickup hours, and limited interior renovation?"
                  />
                </label>

                <div ref={addressSectionRef}>
                  <label className="block text-sm font-semibold text-slate-700" htmlFor="address">
                    Property address
                  </label>
                  <input
                    id="address"
                    className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    onKeyDown={onAddressKeyDown}
                    placeholder="123 Main St, Springfield"
                    autoComplete="off"
                  />
                </div>

                {suggestionLoading && (
                  <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Looking up addresses
                  </p>
                )}

                {suggestions.length > 0 && (
                  <ul className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
                    {suggestions.map((option, index) => (
                      <li key={`${option}-${index}`} className="border-b border-slate-200 last:border-b-0">
                        <button
                          type="button"
                          onClick={() => selectSuggestion(option)}
                          className={`w-full px-4 py-3 text-left text-sm ${
                            index === activeSuggestionIndex ? "bg-amber-100" : "bg-transparent"
                          }`}
                        >
                          {option}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => {
                      void onSubmit();
                    }}
                    disabled={!canSubmit || phase === "intake" || phase === "analyzing"}
                    className="flex-1 rounded-2xl bg-gradient-to-r from-clay to-pine px-5 py-3 font-semibold text-white disabled:opacity-60"
                  >
                    {phase === "intake" || phase === "analyzing"
                      ? "Running zoning review..."
                      : "Run zoning review"}
                  </button>
                  <button
                    type="button"
                    onClick={resetWorkspace}
                    className="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700"
                  >
                    Reset
                  </button>
                </div>

                {error && (
                  <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                    {error}
                  </div>
                )}
              </div>

              <div className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Agent Progress
                    </p>
                    <h2 className="mt-2 font-heading text-2xl text-pine">Three-agent workflow</h2>
                  </div>
                  <p className="text-sm text-slate-600">
                    {phase === "analyzing"
                      ? "Running now"
                      : phase === "done"
                        ? "Latest result"
                        : "Waiting for input"}
                  </p>
                </div>

                <div className="mt-5 grid gap-4">
                  {displayedAgents.map((agent, index) => {
                    const isActive = phase === "analyzing" && index === activeAgentIndex;
                    return (
                      <article
                        key={agent.key}
                        className={`rounded-3xl border p-4 ${statusTone(agent.status, isActive)}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-semibold text-slate-900">{agent.label}</p>
                            <p className="mt-1 text-sm text-slate-700">{agent.headline}</p>
                          </div>
                          <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
                            {isActive ? "Working" : agent.status.replace("_", " ")}
                          </span>
                        </div>
                        {agent.details.length > 0 && (
                          <ul className="mt-3 space-y-2 text-sm text-slate-600">
                            {agent.details.map((detail) => (
                              <li key={detail}>{detail}</li>
                            ))}
                          </ul>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>

              {result && (
                <>
                  <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                            Feasibility Dashboard
                          </p>
                          <h2 className="mt-2 font-heading text-3xl text-pine">
                            {decisionLabel(result.feasibility.decision)}
                          </h2>
                          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700">
                            {result.feasibility.summary}
                          </p>
                        </div>
                        <div
                          className={`rounded-3xl border px-4 py-3 text-center ${decisionTone(
                            result.feasibility.decision,
                          )}`}
                        >
                          <p className="text-xs font-semibold uppercase tracking-[0.18em]">
                            Confidence
                          </p>
                          <p className="mt-1 font-heading text-3xl">
                            {(result.feasibility.confidence * 100).toFixed(0)}%
                          </p>
                        </div>
                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Status</p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {result.status.replace("_", " ")}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">District</p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {intake?.district.replace(/-/g, " ") ?? "Unknown"}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Trace</p>
                          <p className="mt-2 break-all text-xs text-slate-700">{result.traceId}</p>
                        </div>
                      </div>

                      {result.warnings.length > 0 && (
                        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                          {result.warnings.map((warning) => (
                            <p key={warning}>{warning}</p>
                          ))}
                        </div>
                      )}

                      {showHumanFallback && (
                        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                          This review needs a human-in-the-loop follow-up. Please confirm the parcel
                          directly with the zoning or planning office before making project or spending
                          decisions.
                        </div>
                      )}
                    </section>

                    <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                        Downloadable Checklist
                      </p>
                      <p className="mt-3 text-sm leading-6 text-slate-700">
                        Save the current permit path, cited sources, and disclaimers as a plain-text
                        checklist you can bring into the next planning conversation.
                      </p>
                      <button
                        type="button"
                        onClick={downloadChecklist}
                        className="mt-5 w-full rounded-2xl bg-pine px-4 py-3 font-semibold text-white"
                      >
                        Download checklist
                      </button>
                      <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Address</p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {intake?.normalizedAddress ?? "Not available"}
                        </p>
                      </div>
                    </section>
                  </div>

                  <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                    <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                            Required Permit Steps
                          </p>
                          <h3 className="mt-2 font-heading text-2xl text-pine">Checklist</h3>
                        </div>
                        <span className="rounded-full bg-mist px-3 py-1 text-xs font-semibold text-pine">
                          {result.checklist.steps.length} steps
                        </span>
                      </div>

                      <ol className="mt-5 space-y-4">
                        {result.checklist.steps.map((step) => (
                          <li key={step.order} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                            <div className="flex items-start gap-4">
                              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-pine text-sm font-bold text-white">
                                {step.order}
                              </span>
                              <div className="min-w-0">
                                <p className="font-semibold text-slate-900">{step.action}</p>
                                <p className="mt-1 text-sm text-slate-600">{step.department}</p>
                                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                  Required documents
                                </p>
                                <p className="mt-2 text-sm leading-6 text-slate-700">
                                  {step.requiredDocs.join(", ")}
                                </p>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>

                    <div className="space-y-6">
                      <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                          Source References
                        </p>
                        <div className="mt-4 space-y-3">
                          {result.citations.length > 0 ? (
                            result.citations.map((citation) => (
                              <article
                                key={citation.sourceId}
                                className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                              >
                                <p className="font-semibold text-slate-900">{citation.title}</p>
                                <p className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
                                  {citation.sectionRef}
                                </p>
                                <p className="mt-3 text-sm leading-6 text-slate-700">
                                  {citation.excerpt}
                                </p>
                                {citation.url && (
                                  <a
                                    className="mt-3 inline-flex text-sm font-semibold text-clay underline-offset-2 hover:underline"
                                    href={citation.url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open source reference
                                  </a>
                                )}
                              </article>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                              No source excerpts were retrieved for this request.
                            </div>
                          )}
                        </div>
                      </section>

                      <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                          Audit Trace
                        </p>
                        <div className="mt-4 space-y-3">
                          {traceLoading ? (
                            <p className="text-sm text-slate-600">Loading trace…</p>
                          ) : trace.length > 0 ? (
                            trace.map((event) => (
                              <div
                                key={`${event.stage}-${event.createdAt}`}
                                className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                              >
                                <p className="font-semibold text-slate-900">
                                  {event.stage.replaceAll(".", " / ")}
                                </p>
                                <p className="mt-1 text-xs text-slate-500">
                                  {new Date(event.createdAt).toLocaleString()}
                                </p>
                              </div>
                            ))
                          ) : (
                            <p className="text-sm text-slate-600">Trace events will appear here after a run.</p>
                          )}
                        </div>
                      </section>
                    </div>
                  </div>

                  <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                    <section className="rounded-[28px] border border-amber-200 bg-amber-50 p-6 shadow-card md:p-8">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-800">
                        Legal Disclaimer
                      </p>
                      <ul className="mt-4 space-y-3 text-sm leading-6 text-amber-950">
                        {result.disclaimers.map((disclaimer) => (
                          <li key={disclaimer}>{disclaimer}</li>
                        ))}
                      </ul>
                    </section>

                    <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                        Workflow Feedback
                      </p>
                      <p className="mt-3 text-sm leading-6 text-slate-700">
                        Let us know whether the zoning result and checklist were useful.
                      </p>
                      <textarea
                        className="mt-4 min-h-[120px] w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                        value={feedbackNote}
                        onChange={(event) => setFeedbackNote(event.target.value)}
                        placeholder="What was clear, missing, or confusing?"
                      />
                      <div className="mt-4 flex gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            void onSubmitFeedback(true);
                          }}
                          disabled={feedbackState === "submitting"}
                          className="rounded-2xl bg-pine px-4 py-3 font-semibold text-white disabled:opacity-60"
                        >
                          Helpful
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void onSubmitFeedback(false);
                          }}
                          disabled={feedbackState === "submitting"}
                          className="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 disabled:opacity-60"
                        >
                          Needs work
                        </button>
                      </div>
                      {feedbackMessage && (
                        <p className="mt-4 text-sm text-slate-700">{feedbackMessage}</p>
                      )}
                    </section>
                  </div>
                </>
              )}
            </section>

            <aside className="space-y-6">
              <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Project Context
                </p>
                {intake ? (
                  <div className="mt-4 space-y-4 text-sm text-slate-700">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                        Normalized address
                      </p>
                      <p className="mt-2 font-semibold text-slate-900">{intake.normalizedAddress}</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">District</p>
                      <p className="mt-2 font-semibold text-slate-900">
                        {intake.district.replace(/-/g, " ")}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Coordinates</p>
                      <p className="mt-2 font-semibold text-slate-900">
                        {intake.latitude != null && intake.longitude != null
                          ? `${intake.latitude.toFixed(4)}, ${intake.longitude.toFixed(4)}`
                          : "Unavailable"}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 text-sm leading-6 text-slate-600">
                    Normalized parcel context appears here after intake succeeds.
                  </p>
                )}
              </section>

              <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Clarifications
                </p>
                <div className="mt-4 space-y-3">
                  {assistantPrompts.length > 0 ? (
                    assistantPrompts.map((prompt) => (
                      <div key={prompt} className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                        <p className="text-sm text-amber-900">{prompt}</p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm leading-6 text-slate-600">
                      Follow-up questions and confidence warnings will appear here when the agents need more detail.
                    </p>
                  )}
                </div>
              </section>
            </aside>
          </div>
        ) : (
          <section className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
            <div className="space-y-6">
              <div className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Source Editor
                </p>
                <div className="mt-4 space-y-4">
                  <label className="block text-sm font-semibold text-slate-700">
                    Source ID
                    <input
                      className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                      value={sourceForm.sourceId}
                      onChange={(event) =>
                        setSourceForm((current) => ({ ...current, sourceId: event.target.value }))
                      }
                    />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">
                    Title
                    <input
                      className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                      value={sourceForm.title}
                      onChange={(event) =>
                        setSourceForm((current) => ({ ...current, title: event.target.value }))
                      }
                    />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">
                    Excerpt
                    <textarea
                      className="mt-2 min-h-[140px] w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                      value={sourceForm.excerpt}
                      onChange={(event) =>
                        setSourceForm((current) => ({ ...current, excerpt: event.target.value }))
                      }
                    />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">
                    Section reference
                    <input
                      className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                      value={sourceForm.sectionRef}
                      onChange={(event) =>
                        setSourceForm((current) => ({ ...current, sectionRef: event.target.value }))
                      }
                    />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">
                    URL
                    <input
                      className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                      value={sourceForm.url ?? ""}
                      onChange={(event) =>
                        setSourceForm((current) => ({ ...current, url: event.target.value }))
                      }
                    />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">
                    Effective date
                    <input
                      className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                      value={sourceForm.effectiveDate ?? ""}
                      onChange={(event) =>
                        setSourceForm((current) => ({
                          ...current,
                          effectiveDate: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">
                    Districts
                    <input
                      className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                      value={sourceForm.districts.join(", ")}
                      onChange={(event) =>
                        setSourceForm((current) => ({
                          ...current,
                          districts: parseTagList(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label className="block text-sm font-semibold text-slate-700">
                    Uses
                    <input
                      className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                      value={sourceForm.uses.join(", ")}
                      onChange={(event) =>
                        setSourceForm((current) => ({
                          ...current,
                          uses: parseTagList(event.target.value),
                        }))
                      }
                    />
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    void onSaveSource();
                  }}
                  disabled={sourceSaving}
                  className="mt-5 w-full rounded-2xl bg-clay px-4 py-3 font-semibold text-white disabled:opacity-60"
                >
                  {sourceSaving ? "Saving..." : "Save source"}
                </button>
                {sourceMessage && <p className="mt-4 text-sm text-slate-700">{sourceMessage}</p>}
              </div>

              <div className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Ingestion Actions
                </p>
                <label className="mt-4 block text-sm font-semibold text-slate-700">
                  Local document directory
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm"
                    value={importDirectory}
                    onChange={(event) => setImportDirectory(event.target.value)}
                    placeholder="services/ingestion/documents"
                  />
                </label>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => {
                      void onImportDocuments();
                    }}
                    disabled={importing}
                    className="rounded-2xl bg-pine px-4 py-3 font-semibold text-white disabled:opacity-60"
                  >
                    {importing ? "Importing..." : "Import local docs"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void onReindexSources();
                    }}
                    className="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700"
                  >
                    Reindex sources
                  </button>
                </div>
                {importMessage && <p className="mt-4 text-sm text-slate-700">{importMessage}</p>}
                {reindexMessage && <p className="mt-2 text-sm text-slate-700">{reindexMessage}</p>}
              </div>
            </div>

            <div className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                    Registered Sources
                  </p>
                  <h2 className="mt-2 font-heading text-2xl text-pine">Catalog</h2>
                </div>
                <span className="rounded-full bg-mist px-3 py-1 text-xs font-semibold text-pine">
                  {sources.length} sources
                </span>
              </div>

              <div className="mt-5 space-y-3">
                {sourcesLoading ? (
                  <p className="text-sm text-slate-600">Loading sources...</p>
                ) : (
                  sources.map((source) => (
                    <article
                      key={source.sourceId}
                      className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-900">{source.title}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
                            {source.sourceId} · {source.sectionRef}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => loadSourceIntoForm(source)}
                          className="rounded-2xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
                        >
                          Edit
                        </button>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-slate-700">{source.excerpt}</p>
                    </article>
                  ))
                )}
              </div>
            </div>
          </section>
        )}
      </div>

      {clarificationOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Clarification Needed
            </p>
            <h2 className="mt-2 font-heading text-2xl text-pine">
              We need a bit more detail before finishing the zoning call.
            </h2>
            <div className="mt-5 space-y-4">
              {clarificationQuestions.map((question) => (
                <label key={question.id} className="block text-sm font-semibold text-slate-700">
                  {question.question}
                  <textarea
                    className="mt-2 min-h-[96px] w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                    value={clarificationAnswers[question.question] ?? ""}
                    onChange={(event) =>
                      setClarificationAnswers((current) => ({
                        ...current,
                        [question.question]: event.target.value,
                      }))
                    }
                  />
                  <span className="mt-2 block text-xs font-normal leading-5 text-slate-500">
                    {question.reason}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  void onSubmitClarifications();
                }}
                disabled={clarificationSubmitting}
                className="flex-1 rounded-2xl bg-pine px-4 py-3 font-semibold text-white disabled:opacity-60"
              >
                {clarificationSubmitting ? "Submitting..." : "Continue review"}
              </button>
              <button
                type="button"
                onClick={() => setClarificationOpen(false)}
                className="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
