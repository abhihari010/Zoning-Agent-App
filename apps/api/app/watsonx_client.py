from __future__ import annotations

import json
import os
import time
from typing import Any

import httpx

WATSONX_API_VERSION = "2023-05-29"
UTILITY_TOOLS_API_VERSION = "2024-05-01"


def is_watsonx_enabled() -> bool:
    return os.getenv("WATSONX_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not configured.")
    return value


def _watsonx_timeout() -> float:
    return float(os.getenv("WATSONX_TIMEOUT_SECONDS", "20"))


def _watsonx_max_attempts() -> int:
    return max(1, int(os.getenv("WATSONX_MAX_ATTEMPTS", "3")))


def _watsonx_retry_delay_seconds() -> float:
    return max(0.0, float(os.getenv("WATSONX_RETRY_DELAY_SECONDS", "0.6")))


def _should_retry_status(status_code: int) -> bool:
    return status_code in {408, 409, 425, 429, 500, 502, 503, 504}


def _sleep_before_retry(attempt: int, max_attempts: int) -> None:
    if attempt >= max_attempts:
        return
    delay = _watsonx_retry_delay_seconds() * attempt
    if delay > 0:
        time.sleep(delay)


def _post_with_retry(
    url: str,
    *,
    timeout_seconds: float,
    error_label: str,
    **request_kwargs: Any,
) -> httpx.Response:
    max_attempts = _watsonx_max_attempts()
    last_error: RuntimeError | None = None

    for attempt in range(1, max_attempts + 1):
        try:
            response = httpx.post(url, timeout=timeout_seconds, **request_kwargs)
            if _should_retry_status(response.status_code):
                last_error = RuntimeError(
                    f"{error_label} returned HTTP {response.status_code} on attempt {attempt}/{max_attempts}."
                )
                _sleep_before_retry(attempt, max_attempts)
                continue

            response.raise_for_status()
            return response
        except httpx.TimeoutException as exc:
            last_error = RuntimeError(
                f"{error_label} timed out on attempt {attempt}/{max_attempts} after {timeout_seconds:.0f}s."
            )
        except httpx.TransportError as exc:
            last_error = RuntimeError(
                f"{error_label} transport error on attempt {attempt}/{max_attempts}: {exc}"
            )
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            if not _should_retry_status(status_code):
                raise RuntimeError(f"{error_label} failed with HTTP {status_code}.") from exc
            last_error = RuntimeError(
                f"{error_label} returned HTTP {status_code} on attempt {attempt}/{max_attempts}."
            )

        _sleep_before_retry(attempt, max_attempts)

    assert last_error is not None
    raise last_error


def _get_iam_token(api_key: str, timeout_seconds: float) -> str:
    # IBM displays keys as "ApiKey-<value>" — IAM endpoint wants only the value part
    clean_key = api_key.removeprefix("ApiKey-")
    response = _post_with_retry(
        "https://iam.cloud.ibm.com/identity/token",
        timeout_seconds=timeout_seconds,
        error_label="watsonx IAM token request",
        data={
            "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
            "apikey": clean_key,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise ValueError("IAM token response did not include access_token.")
    return str(token)


def _extract_first_json(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("No JSON object found in watsonx output.")


def search_ordinances(query: str) -> list[dict[str, str]]:
    """Query the Blacksburg VA Code of Ordinances vector index and return relevant passages."""
    api_key = _required_env("WATSONX_API_KEY")
    platform_url = os.getenv("WATSONX_PLATFORM_URL", "https://api.dataplatform.cloud.ibm.com").rstrip("/")
    project_id = _required_env("WATSONX_PROJECT_ID")
    vector_index_id = _required_env("WATSONX_VECTOR_INDEX_ID")
    timeout_seconds = _watsonx_timeout()

    token = _get_iam_token(api_key=api_key, timeout_seconds=timeout_seconds)

    response = _post_with_retry(
        f"{platform_url}/wx/v1-beta/utility_agent_tools/run",
        timeout_seconds=timeout_seconds,
        error_label="watsonx ordinance retrieval",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json={
            "tool_name": "RAGQuery",
            "input": query,
            "config": {
                "vectorIndexId": vector_index_id,
                "projectId": project_id,
            },
        },
    )
    payload = response.json()

    raw_output = payload.get("output", "")

    try:
        parsed = json.loads(raw_output) if isinstance(raw_output, str) else raw_output
    except json.JSONDecodeError:
        parsed = raw_output

    # Normalise to a list of passage dicts with at least a "text" key
    if isinstance(parsed, list):
        passages = []
        for item in parsed:
            if isinstance(item, dict):
                passages.append(item)
            elif isinstance(item, str):
                passages.append({"text": item})
        return passages

    if isinstance(parsed, dict):
        results = parsed.get("results") or parsed.get("passages") or parsed.get("documents") or []
        if results:
            return [
                item if isinstance(item, dict) else {"text": str(item)}
                for item in results
            ]
        # Single result wrapped in a dict
        text = parsed.get("text") or parsed.get("content") or str(parsed)
        return [{"text": text}]

    # Plain text fallback
    if isinstance(raw_output, str) and raw_output.strip():
        return [{"text": raw_output.strip()}]

    return []


def generate_watsonx_analysis(
    *,
    project_description: str,
    district: str,
    citation_excerpts: list[str],
    missing_fields: list[str],
) -> dict[str, Any]:
    api_key = _required_env("WATSONX_API_KEY")
    watsonx_url = _required_env("WATSONX_URL").rstrip("/")
    project_id = _required_env("WATSONX_PROJECT_ID")
    model_id = _required_env("WATSONX_MODEL_ID")
    timeout_seconds = _watsonx_timeout()

    token = _get_iam_token(api_key=api_key, timeout_seconds=timeout_seconds)

    citations_block = (
        "\n".join(f"- {excerpt}" for excerpt in citation_excerpts[:5])
        if citation_excerpts
        else "No ordinance excerpts were retrieved."
    )

    system_prompt = (
        "You are a zoning compliance assistant for Blacksburg, VA. "
        "Analyse the project against the provided ordinance excerpts. "
        "Respond ONLY with a valid JSON object containing exactly these keys: "
        "decision (one of: likely_allowed, conditional, restricted, unknown), "
        "summary (2-3 sentence plain-language feasibility summary), "
        "required_permits (array of strings), "
        "follow_up_questions (array of strings), "
        "warnings (array of strings)."
    )

    user_content = (
        f"District: {district}\n"
        f"Project: {project_description}\n"
        f"Missing information: {', '.join(missing_fields) if missing_fields else 'none'}\n\n"
        f"Relevant Blacksburg ordinance excerpts:\n{citations_block}"
    )

    response = _post_with_retry(
        f"{watsonx_url}/ml/v1/text/chat",
        timeout_seconds=timeout_seconds,
        error_label="watsonx analysis request",
        params={"version": WATSONX_API_VERSION},
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json={
            "model_id": model_id,
            "project_id": project_id,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "parameters": {
                "decoding_method": "greedy",
                "max_new_tokens": 600,
                "min_new_tokens": 80,
            },
        },
    )
    payload = response.json()

    generated_text = ""
    choices = payload.get("choices", [])
    if choices and isinstance(choices[0], dict):
        message = choices[0].get("message", {})
        generated_text = str(message.get("content", "")).strip()

    # Fallback to results format (text/generation style)
    if not generated_text:
        results = payload.get("results", [])
        if results and isinstance(results[0], dict):
            generated_text = str(results[0].get("generated_text", "")).strip()

    if not generated_text:
        raise ValueError("watsonx response did not include generated text.")

    parsed = _extract_first_json(generated_text)

    decision = str(parsed.get("decision", "unknown"))
    if decision not in {"likely_allowed", "conditional", "restricted", "unknown"}:
        decision = "unknown"

    summary = str(parsed.get("summary", "Insufficient model summary."))
    required_permits = parsed.get("required_permits", [])
    follow_up_questions = parsed.get("follow_up_questions", [])
    warnings = parsed.get("warnings", [])

    return {
        "decision": decision,
        "summary": summary,
        "required_permits": [str(item) for item in required_permits if item],
        "follow_up_questions": [str(item) for item in follow_up_questions if item],
        "warnings": [str(item) for item in warnings if item],
    }
