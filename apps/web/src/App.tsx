import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
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
  submitFeedback,
  suggestAddresses,
  type IntakeResponse,
  type SourceRegistryEntry,
} from "./api";

const DISCLAIMER =
  "This assistant provides educational guidance only and does not provide official legal approval.";

type Phase = "idle" | "intake" | "analyzing" | "done" | "error";
type FeedbackState = "idle" | "submitting" | "submitted";
type Workspace = "assistant" | "admin";

const PHASE_COPY: Record<Phase, string> = {
  idle: "Waiting for a project brief and validated address.",
  intake: "Validating the address, zoning context, and parcel details.",
  analyzing: "Running intent extraction, rule retrieval, and checklist generation.",
  done: "Analysis complete with citations, checklist, and traceable guidance.",
  error: "Something interrupted the workflow before we could complete the review.",
};

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

function stringifyTagList(values: string[]): string {
  return values.join(", ");
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
  const [error, setError] = useState<string | null>(null);
  const [intake, setIntake] = useState<IntakeResponse | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [trace, setTrace] = useState<AuditEvent[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackState, setFeedbackState] = useState<FeedbackState>("idle");
  const [feedbackMessage, setFeedbackMessage] = useState("");
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
    }, 250);

    return () => clearTimeout(handle);
  }, [address, autocompleteSession]);

  useEffect(() => {
    const onDocumentPointerDown = (event: MouseEvent) => {
      const container = addressSectionRef.current;
      if (!container) {
        return;
      }
      if (!container.contains(event.target as Node)) {
        setSuggestions([]);
        setActiveSuggestionIndex(-1);
      }
    };

    document.addEventListener("mousedown", onDocumentPointerDown);
    return () => document.removeEventListener("mousedown", onDocumentPointerDown);
  }, []);

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
  }, [intake, phase]);

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
      setActiveSuggestionIndex((prev) => (prev + 1) % suggestions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestionIndex((prev) =>
        prev <= 0 ? suggestions.length - 1 : prev - 1,
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

  const canSubmit = useMemo(() => {
    return (
      acceptedDisclaimer &&
      projectDescription.trim().length > 10 &&
      address.trim().length > 5
    );
  }, [acceptedDisclaimer, projectDescription, address]);

  const assistantPrompts = useMemo(() => {
    const prompts: FollowUpQuestion[] = [];
    if (intake) {
      prompts.push(...intake.followUpQuestions);
    }
    if (result) {
      prompts.push(...result.followUpQuestions);
    }
    return prompts;
  }, [intake, result]);

  const progressSteps = useMemo(() => {
    const activeIndex =
      phase === "idle"
        ? 0
        : phase === "intake"
          ? 1
          : phase === "analyzing"
            ? 2
            : 3;

    return [
      {
        label: "Intake",
        description: "Plain-English project brief with legal disclaimer acceptance.",
      },
      {
        label: "Location",
        description: "Address validation, district mapping, and parcel context.",
      },
      {
        label: "Reasoning",
        description: "Intent extraction, rule lookup, confidence scoring, and checklist generation.",
      },
      {
        label: "Decision",
        description: "Feasibility summary, citations, warnings, and next steps.",
      },
    ].map((step, index) => ({
      ...step,
      state:
        index < activeIndex
          ? "complete"
          : index === activeIndex
            ? "current"
            : "upcoming",
    }));
  }, [phase]);

  async function refreshSources(message?: string) {
    const nextSources = await listSources();
    setSources(nextSources);
    if (message) {
      setSourceMessage(message);
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
    setSuggestions([]);
    setActiveSuggestionIndex(-1);

    try {
      setPhase("intake");
      const sessionId = await createSession();
      const intakeResult = await intakeProject({
        session_id: sessionId,
        project_description: projectDescription,
        address,
      });
      setIntake(intakeResult);

      if (intakeResult.status !== "created") {
        setPhase("error");
        setError("Address validation needs more detail before zoning analysis can continue.");
        return;
      }

      setPhase("analyzing");
      const analysis = await analyzeProject(intakeResult.projectId);
      setResult(analysis);
      setPhase("done");
    } catch (submitError) {
      setPhase("error");
      setError(
        submitError instanceof Error ? submitError.message : "Unknown error",
      );
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
          ? "Feedback saved. We can build on this workflow from here."
          : "Feedback saved. This gives us a clear signal on what to improve next.",
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
      setSourceMessage("Source saved to the registry.");
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
      const resultSummary = await reindexSources();
      setReindexMessage(
        `Reindex ${resultSummary.status}. ${resultSummary.sourceCount} sources are registered.`,
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
        `Imported ${importResult.importedCount} documents into ${importResult.sourceCount} total sources.`,
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
          : "Failed to import documents.",
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
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(217,120,85,0.22),transparent_28%),radial-gradient(circle_at_top_right,rgba(23,52,43,0.16),transparent_24%),linear-gradient(180deg,#f7f0e4_0%,#efe4d2_100%)]">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl gap-6 px-4 py-6 md:px-8 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="rounded-[28px] border border-pine/10 bg-white/70 p-5 shadow-card backdrop-blur md:sticky md:top-6 md:h-[calc(100vh-3rem)] md:overflow-auto">
          <p className="inline-flex rounded-full border border-clay/30 bg-clay/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-clay">
            IBM Zoning Assistant
          </p>
          <h1 className="mt-4 font-heading text-3xl leading-tight text-pine">
            Guided zoning feasibility workspace
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-700">
            Analyze project feasibility or manage the municipal source catalog
            that powers retrieval.
          </p>

          <div className="mt-6 grid gap-3">
            <button
              type="button"
              onClick={() => setWorkspace("assistant")}
              className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                workspace === "assistant"
                  ? "bg-pine text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:border-pine hover:text-pine"
              }`}
            >
              Assistant Workspace
            </button>
            <button
              type="button"
              onClick={() => setWorkspace("admin")}
              className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                workspace === "admin"
                  ? "bg-clay text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:border-clay hover:text-clay"
              }`}
            >
              Source Admin
            </button>
          </div>

          <div className="mt-6 rounded-3xl border border-pine/10 bg-mist/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Workflow Status
            </p>
            <p className="mt-2 font-heading text-xl text-pine">
              {workspace === "admin"
                ? "Catalog operations"
                : phase === "done"
                  ? "Ready for review"
                  : phase === "error"
                    ? "Needs attention"
                    : "In progress"}
            </p>
            <p className="mt-2 text-sm text-slate-700">
              {workspace === "admin"
                ? "Manage, import, and reindex the zoning sources used by the assistant."
                : PHASE_COPY[phase]}
            </p>
          </div>

          <div className="mt-6 space-y-3">
            {progressSteps.map((step) => (
              <div
                key={step.label}
                className={`rounded-2xl border px-4 py-3 ${
                  workspace === "admin"
                    ? "border-slate-200 bg-white"
                    : step.state === "complete"
                      ? "border-emerald-200 bg-emerald-50"
                      : step.state === "current"
                        ? "border-clay/40 bg-clay/10"
                        : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                      workspace === "admin"
                        ? "bg-slate-200 text-slate-600"
                        : step.state === "complete"
                          ? "bg-emerald-600 text-white"
                          : step.state === "current"
                            ? "bg-clay text-white"
                            : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {workspace === "admin"
                      ? step.label.slice(0, 1)
                      : step.state === "complete"
                        ? "OK"
                        : step.label.slice(0, 1)}
                  </span>
                  <div>
                    <p className="font-semibold text-slate-900">{step.label}</p>
                    <p className="text-xs leading-5 text-slate-600">
                      {step.description}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-3xl border border-amber-200 bg-amber-50/90 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">
              Guardrail
            </p>
            <p className="mt-2 text-sm leading-6 text-amber-900">{DISCLAIMER}</p>
          </div>

          <button
            type="button"
            onClick={resetWorkspace}
            className="mt-6 w-full rounded-2xl border border-pine/15 bg-white px-4 py-3 text-sm font-semibold text-pine transition hover:bg-pine hover:text-white"
          >
            Start New Review
          </button>
        </aside>

        <div className="space-y-6">
          <section className="overflow-hidden rounded-[30px] border border-pine/10 bg-white/80 shadow-card backdrop-blur">
            <div className="grid gap-6 px-6 py-6 md:px-8 md:py-8 xl:grid-cols-[1.1fr_0.9fr]">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-500">
                  {workspace === "assistant" ? "Planning Intake" : "Source Operations"}
                </p>
                <h2 className="mt-3 font-heading text-4xl leading-tight text-pine">
                  {workspace === "assistant"
                    ? "Turn a plain-English idea into a source-backed permit path"
                    : "Manage the source catalog and import local municipal documents"}
                </h2>
                <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-700 md:text-base">
                  {workspace === "assistant"
                    ? "Describe the project the way a resident or business owner would, then let the app validate location context and return a zoning recommendation with practical next steps."
                    : "Use the admin workspace to seed source records, edit citations, and import `.md`, `.txt`, or `.json` files from a local document folder into the persistent registry."}
                </p>
              </div>

              <div className="rounded-[26px] border border-pine/10 bg-[linear-gradient(160deg,rgba(23,52,43,0.98),rgba(33,73,60,0.95))] p-5 text-white shadow-lg">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
                  {workspace === "assistant" ? "What this build shows" : "Admin workflow now available"}
                </p>
                <ul className="mt-4 space-y-3 text-sm leading-6 text-white/90">
                  {workspace === "assistant" ? (
                    <>
                      <li>Validated address intake with district context</li>
                      <li>Progressive workflow states while analysis runs</li>
                      <li>Clarifications, citations, warnings, and audit trace</li>
                      <li>Permit checklist and post-result feedback capture</li>
                    </>
                  ) : (
                    <>
                      <li>Persistent source registry listing and manual editing</li>
                      <li>Folder-based ingestion for local `.md`, `.txt`, and `.json` docs</li>
                      <li>Reindex trigger aligned with the source catalog</li>
                      <li>Immediate visibility into the sources powering analysis</li>
                    </>
                  )}
                </ul>
              </div>
            </div>
          </section>

          {workspace === "assistant" ? (
            <>
              <section className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
                <div className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                  <label className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-sm text-slate-700">
                    <input
                      className="mt-1 h-4 w-4 accent-clay"
                      type="checkbox"
                      checked={acceptedDisclaimer}
                      onChange={(event) => setAcceptedDisclaimer(event.target.checked)}
                    />
                    <span>{DISCLAIMER}</span>
                  </label>

                  <label className="mb-4 block text-sm font-semibold text-slate-700">
                    Project Description
                    <textarea
                      className="mt-2 min-h-[160px] w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm outline-none ring-clay transition focus:border-clay focus:ring-2"
                      value={projectDescription}
                      onChange={(event) => setProjectDescription(event.target.value)}
                      placeholder="Example: Convert my attached garage into a small bakery with two employees, weekday pickup hours, and limited facade changes."
                      rows={6}
                    />
                  </label>

                  <div ref={addressSectionRef} className="mb-4">
                    <label
                      className="block text-sm font-semibold text-slate-700"
                      htmlFor="project-address"
                    >
                      Project Address
                    </label>
                    <input
                      id="project-address"
                      className="mt-2 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                      type="text"
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                      onKeyDown={onAddressKeyDown}
                      placeholder="123 Main St, Springfield"
                      autoComplete="off"
                      aria-autocomplete="list"
                      aria-expanded={suggestions.length > 0}
                      aria-controls="address-suggestions"
                      aria-activedescendant={
                        activeSuggestionIndex >= 0
                          ? `address-suggestion-${activeSuggestionIndex}`
                          : undefined
                      }
                    />
                  </div>

                  {suggestionLoading && (
                    <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                      Searching addresses
                    </p>
                  )}
                  {suggestions.length > 0 && (
                    <ul
                      id="address-suggestions"
                      role="listbox"
                      className="mb-4 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 text-sm"
                    >
                      {suggestions.map((option, index) => (
                        <li
                          key={`${option}-${index}`}
                          role="option"
                          aria-selected={index === activeSuggestionIndex}
                          className="border-b border-slate-200 last:border-b-0"
                        >
                          <button
                            id={`address-suggestion-${index}`}
                            type="button"
                            className={`w-full px-4 py-3 text-left text-slate-700 transition hover:bg-amber-50 ${
                              index === activeSuggestionIndex ? "bg-amber-100" : ""
                            }`}
                            onClick={() => selectSuggestion(option)}
                          >
                            {option}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex flex-col gap-3 sm:flex-row">
                    <button
                      className="flex-1 rounded-2xl bg-gradient-to-r from-clay to-pine px-5 py-3 font-semibold text-white shadow-lg shadow-clay/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      onClick={() => {
                        void onSubmit();
                      }}
                      disabled={!canSubmit || phase === "intake" || phase === "analyzing"}
                    >
                      {phase === "intake" || phase === "analyzing"
                        ? "Running analysis..."
                        : "Analyze zoning feasibility"}
                    </button>
                    <button
                      type="button"
                      onClick={resetWorkspace}
                      className="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 transition hover:border-pine hover:text-pine"
                    >
                      Clear
                    </button>
                  </div>

                  {error && (
                    <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                      {error}
                    </div>
                  )}
                </div>

                <div className="space-y-6">
                  <section className="rounded-[28px] border border-pine/10 bg-white p-6 shadow-card">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Assistant Guidance
                    </p>
                    <h3 className="mt-2 font-heading text-2xl text-pine">
                      Questions and workflow notes
                    </h3>
                    <div className="mt-4 space-y-3">
                      {assistantPrompts.length > 0 ? (
                        assistantPrompts.map((prompt) => (
                          <div
                            key={prompt.id}
                            className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4"
                          >
                            <p className="text-sm font-semibold text-amber-900">
                              {prompt.question}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-amber-800">
                              {prompt.reason}
                            </p>
                          </div>
                        ))
                      ) : (
                        <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                          Once you run an analysis, this panel will surface missing
                          inputs, uncertainty notes, and next clarifications.
                        </p>
                      )}
                    </div>
                  </section>

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
                          <p className="mt-2 font-semibold text-slate-900">
                            {intake.normalizedAddress}
                          </p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                              District
                            </p>
                            <p className="mt-2 font-semibold capitalize text-slate-900">
                              {intake.district.replace(/-/g, " ")}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                              Geo status
                            </p>
                            <p className="mt-2 font-semibold text-slate-900">
                              {intake.latitude != null && intake.longitude != null
                                ? `${intake.latitude.toFixed(3)}, ${intake.longitude.toFixed(3)}`
                                : "Coordinates unavailable"}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                        This area will show normalized address, mapped district, and
                        geospatial context once intake succeeds.
                      </p>
                    )}
                  </section>
                </div>
              </section>

              {result && (
                <section className="space-y-6">
                  <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
                    <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                      <header className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                            Feasibility Decision
                          </p>
                          <h2 className="mt-2 font-heading text-3xl text-pine md:text-4xl">
                            {result.feasibility.decision.replace("_", " ")}
                          </h2>
                          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700 md:text-base">
                            {result.feasibility.summary}
                          </p>
                        </div>
                        <div className="rounded-3xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-center">
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                            Confidence
                          </p>
                          <p className="mt-1 font-heading text-3xl text-emerald-700">
                            {(result.feasibility.confidence * 100).toFixed(0)}%
                          </p>
                        </div>
                      </header>

                      {result.warnings.length > 0 && (
                        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                          {result.warnings.map((warning) => (
                            <p key={warning}>{warning}</p>
                          ))}
                        </div>
                      )}

                      <div className="mt-6 grid gap-4 md:grid-cols-3">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Status
                          </p>
                          <p className="mt-2 font-semibold capitalize text-slate-900">
                            {result.status.replace("_", " ")}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Permits
                          </p>
                          <p className="mt-2 font-semibold text-slate-900">
                            {result.checklist.permits.length}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                            Trace ID
                          </p>
                          <p className="mt-2 break-all font-mono text-xs text-slate-700">
                            {result.traceId}
                          </p>
                        </div>
                      </div>
                    </section>

                    <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                        Permit Summary
                      </p>
                      <div className="mt-4 space-y-3">
                        {result.checklist.permits.map((permit) => (
                          <div
                            key={permit}
                            className="rounded-2xl border border-pine/10 bg-mist/70 px-4 py-3"
                          >
                            <p className="font-semibold text-pine">{permit}</p>
                          </div>
                        ))}
                      </div>

                      <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                          Departments
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-700">
                          {result.checklist.departments.join(", ")}
                        </p>
                      </div>

                      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                          Required documents
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-700">
                          {result.checklist.documents.join(", ")}
                        </p>
                      </div>
                    </section>
                  </div>

                  <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                    <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                        Checklist Timeline
                      </p>
                      <ol className="mt-6 space-y-4">
                        {result.checklist.steps.map((step) => (
                          <li
                            key={step.order}
                            className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                          >
                            <div className="flex flex-wrap items-center gap-3">
                              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-pine text-sm font-bold text-white">
                                {step.order}
                              </span>
                              <div>
                                <h3 className="font-semibold text-slate-900">
                                  {step.action}
                                </h3>
                                <p className="text-sm text-slate-600">
                                  {step.department}
                                </p>
                              </div>
                            </div>
                            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Required docs
                            </p>
                            <p className="mt-2 text-sm leading-6 text-slate-700">
                              {step.requiredDocs.join(", ")}
                            </p>
                          </li>
                        ))}
                      </ol>
                    </section>

                    <section className="space-y-6">
                      <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                          Source Citations
                        </p>
                        <div className="mt-4 space-y-3">
                          {result.citations.map((citation) => (
                            <article
                              key={citation.sourceId}
                              className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <h3 className="font-semibold text-slate-900">
                                    {citation.title}
                                  </h3>
                                  <p className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
                                    {citation.sectionRef}
                                  </p>
                                </div>
                                {citation.effectiveDate && (
                                  <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600">
                                    Effective {citation.effectiveDate}
                                  </span>
                                )}
                              </div>
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
                          ))}
                        </div>
                      </section>

                      <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                          Audit Trace
                        </p>
                        {traceLoading ? (
                          <p className="mt-4 text-sm text-slate-600">
                            Loading workflow trace...
                          </p>
                        ) : trace.length > 0 ? (
                          <div className="mt-4 space-y-3">
                            {trace.map((event) => (
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
                            ))}
                          </div>
                        ) : (
                          <p className="mt-4 text-sm text-slate-600">
                            Trace data will appear here after the workflow records
                            intake and analysis events.
                          </p>
                        )}
                      </section>
                    </section>
                  </div>

                  <section className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                    <section className="rounded-[30px] border border-amber-200 bg-amber-50/80 p-6 shadow-card md:p-8">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-800">
                        Disclaimers
                      </p>
                      <ul className="mt-4 space-y-3 text-sm leading-6 text-amber-950">
                        {result.disclaimers.map((disclaimer) => (
                          <li key={disclaimer}>{disclaimer}</li>
                        ))}
                      </ul>
                    </section>

                    <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                        Response Feedback
                      </p>
                      <p className="mt-3 text-sm leading-6 text-slate-700">
                        Capture whether this analysis was useful so the workflow can
                        be tuned for clearer zoning outcomes.
                      </p>
                      <textarea
                        className="mt-4 min-h-[120px] w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                        value={feedbackNote}
                        onChange={(event) => setFeedbackNote(event.target.value)}
                        placeholder="Optional note: what felt clear, missing, or risky?"
                      />
                      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                        <button
                          type="button"
                          onClick={() => {
                            void onSubmitFeedback(true);
                          }}
                          disabled={feedbackState === "submitting" || feedbackState === "submitted"}
                          className="rounded-2xl bg-pine px-5 py-3 font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Helpful
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void onSubmitFeedback(false);
                          }}
                          disabled={feedbackState === "submitting" || feedbackState === "submitted"}
                          className="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 transition hover:border-clay hover:text-clay disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Needs improvement
                        </button>
                      </div>
                      {feedbackMessage && (
                        <p className="mt-4 text-sm text-slate-700">{feedbackMessage}</p>
                      )}
                    </section>
                  </section>
                </section>
              )}
            </>
          ) : (
            <section className="space-y-6">
              <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                        Source Registry
                      </p>
                      <h3 className="mt-2 font-heading text-2xl text-pine">
                        Catalog editor
                      </h3>
                    </div>
                    <span className="rounded-full border border-pine/15 bg-mist/80 px-3 py-1 text-sm font-semibold text-pine">
                      {sources.length} sources
                    </span>
                  </div>

                  <div className="mt-6 grid gap-4">
                    <label className="text-sm font-semibold text-slate-700">
                      Source ID
                      <input
                        className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                        value={sourceForm.sourceId}
                        onChange={(event) =>
                          setSourceForm((current) => ({
                            ...current,
                            sourceId: event.target.value,
                          }))
                        }
                        placeholder="parking-code-2.9"
                      />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">
                      Title
                      <input
                        className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                        value={sourceForm.title}
                        onChange={(event) =>
                          setSourceForm((current) => ({
                            ...current,
                            title: event.target.value,
                          }))
                        }
                        placeholder="Parking Code 2.9"
                      />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">
                      Section Reference
                      <input
                        className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                        value={sourceForm.sectionRef}
                        onChange={(event) =>
                          setSourceForm((current) => ({
                            ...current,
                            sectionRef: event.target.value,
                          }))
                        }
                        placeholder="Sec 2.9"
                      />
                    </label>
                    <label className="text-sm font-semibold text-slate-700">
                      Excerpt
                      <textarea
                        className="mt-2 min-h-[120px] w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                        value={sourceForm.excerpt}
                        onChange={(event) =>
                          setSourceForm((current) => ({
                            ...current,
                            excerpt: event.target.value,
                          }))
                        }
                        placeholder="Short summary or cited excerpt from the ordinance."
                      />
                    </label>
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="text-sm font-semibold text-slate-700">
                        URL
                        <input
                          className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                          value={sourceForm.url ?? ""}
                          onChange={(event) =>
                            setSourceForm((current) => ({
                              ...current,
                              url: event.target.value,
                            }))
                          }
                          placeholder="https://example.gov/parking/2.9"
                        />
                      </label>
                      <label className="text-sm font-semibold text-slate-700">
                        Effective Date
                        <input
                          className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                          value={sourceForm.effectiveDate ?? ""}
                          onChange={(event) =>
                            setSourceForm((current) => ({
                              ...current,
                              effectiveDate: event.target.value,
                            }))
                          }
                          placeholder="2025-02-01"
                        />
                      </label>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="text-sm font-semibold text-slate-700">
                        Districts
                        <input
                          className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                          value={stringifyTagList(sourceForm.districts)}
                          onChange={(event) =>
                            setSourceForm((current) => ({
                              ...current,
                              districts: parseTagList(event.target.value),
                            }))
                          }
                          placeholder="mixed-use-core, industrial-zone"
                        />
                      </label>
                      <label className="text-sm font-semibold text-slate-700">
                        Uses
                        <input
                          className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                          value={stringifyTagList(sourceForm.uses)}
                          onChange={(event) =>
                            setSourceForm((current) => ({
                              ...current,
                              uses: parseTagList(event.target.value),
                            }))
                          }
                          placeholder="home-based-food-business, general"
                        />
                      </label>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => {
                        void onSaveSource();
                      }}
                      disabled={sourceSaving}
                      className="rounded-2xl bg-gradient-to-r from-clay to-pine px-5 py-3 font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {sourceSaving ? "Saving..." : "Save source"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSourceForm(emptySourceForm());
                        setSourceMessage("Source editor cleared.");
                      }}
                      className="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 transition hover:border-pine hover:text-pine"
                    >
                      New source
                    </button>
                  </div>
                  {sourceMessage && (
                    <p className="mt-4 text-sm text-slate-700">{sourceMessage}</p>
                  )}
                </section>

                <section className="space-y-6">
                  <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Import Pipeline
                    </p>
                    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <label className="text-sm font-semibold text-slate-700">
                        Local document directory
                        <input
                          className="mt-2 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-clay focus:ring-2 focus:ring-clay"
                          value={importDirectory}
                          onChange={(event) => setImportDirectory(event.target.value)}
                          placeholder="Leave blank to use services/ingestion/documents"
                        />
                      </label>
                      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                        <button
                          type="button"
                          onClick={() => {
                            void onImportDocuments();
                          }}
                          disabled={importing}
                          className="rounded-2xl bg-pine px-5 py-3 font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {importing ? "Importing..." : "Import local documents"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void onReindexSources();
                          }}
                          className="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 transition hover:border-clay hover:text-clay"
                        >
                          Reindex sources
                        </button>
                      </div>
                    </div>
                    {importMessage && (
                      <p className="mt-4 text-sm text-slate-700">{importMessage}</p>
                    )}
                    {reindexMessage && (
                      <p className="mt-2 text-sm text-slate-700">{reindexMessage}</p>
                    )}
                  </section>

                  <section className="rounded-[30px] border border-pine/10 bg-white p-6 shadow-card md:p-8">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                          Registered Sources
                        </p>
                        <h3 className="mt-2 font-heading text-2xl text-pine">
                          Source catalog
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void refreshSources("Source list refreshed.");
                        }}
                        className="rounded-2xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-pine hover:text-pine"
                      >
                        Refresh
                      </button>
                    </div>

                    {sourcesLoading ? (
                      <p className="mt-4 text-sm text-slate-600">Loading sources...</p>
                    ) : (
                      <div className="mt-4 space-y-3">
                        {sources.map((source) => (
                          <article
                            key={source.sourceId}
                            className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h4 className="font-semibold text-slate-900">
                                  {source.title}
                                </h4>
                                <p className="mt-1 font-mono text-xs text-slate-500">
                                  {source.sourceId} • {source.sectionRef}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => loadSourceIntoForm(source)}
                                className="rounded-full border border-clay/30 bg-white px-3 py-1 text-xs font-semibold text-clay transition hover:bg-clay hover:text-white"
                              >
                                Edit
                              </button>
                            </div>
                            <p className="mt-3 text-sm leading-6 text-slate-700">
                              {source.excerpt}
                            </p>
                            <p className="mt-3 text-xs uppercase tracking-[0.16em] text-slate-500">
                              Districts: {source.districts.join(", ")}
                            </p>
                            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
                              Uses: {source.uses.join(", ")}
                            </p>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                </section>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
