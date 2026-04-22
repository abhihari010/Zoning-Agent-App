from __future__ import annotations

import json
import os
from typing import Any

import httpx

WATSONX_API_VERSION = "2023-05-29"


def is_watsonx_enabled() -> bool:
    return os.getenv("WATSONX_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not configured.")
    return value


def _watsonx_timeout() -> float:
    return float(os.getenv("WATSONX_TIMEOUT_SECONDS", "20"))


def _get_iam_token(api_key: str, timeout_seconds: float) -> str:
    response = httpx.post(
        "https://iam.cloud.ibm.com/identity/token",
        data={
            "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
            "apikey": api_key,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
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

    prompt = (
        "You are a zoning assistant. Produce only JSON with keys: "
        "decision, summary, required_permits, follow_up_questions, warnings. "
        "decision must be one of likely_allowed, conditional, restricted, unknown.\n\n"
        f"District: {district}\n"
        f"Project: {project_description}\n"
        f"Missing fields: {', '.join(missing_fields) if missing_fields else 'none'}\n"
        "Citations:\n"
        + "\n".join(f"- {excerpt}" for excerpt in citation_excerpts[:5])
    )

    response = httpx.post(
        f"{watsonx_url}/ml/v1/text/generation",
        params={"version": WATSONX_API_VERSION},
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json={
            "model_id": model_id,
            "project_id": project_id,
            "input": prompt,
            "parameters": {
                "decoding_method": "greedy",
                "max_new_tokens": 500,
                "min_new_tokens": 80,
            },
        },
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()

    generated_text = ""
    results = payload.get("results", [])
    if results and isinstance(results[0], dict):
        generated_text = str(results[0].get("generated_text", "")).strip()

    if not generated_text:
        raise ValueError("watsonx response did not include generated_text.")

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
