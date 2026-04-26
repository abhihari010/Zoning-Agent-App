from __future__ import annotations

import pytest

from app import watsonx_client


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


def test_post_with_retry_succeeds_after_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}

    def fake_post(url: str, timeout: float, **kwargs):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise watsonx_client.httpx.ReadTimeout("timed out")
        return FakeResponse({"ok": True})

    monkeypatch.setenv("WATSONX_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("WATSONX_RETRY_DELAY_SECONDS", "0")
    monkeypatch.setattr(watsonx_client.httpx, "post", fake_post)

    response = watsonx_client._post_with_retry(
        "https://example.com",
        timeout_seconds=5,
        error_label="watsonx analysis request",
        json={"hello": "world"},
    )

    assert response.json() == {"ok": True}
    assert attempts["count"] == 2


def test_post_with_retry_raises_after_max_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_post(url: str, timeout: float, **kwargs):
        raise watsonx_client.httpx.ReadTimeout("timed out")

    monkeypatch.setenv("WATSONX_MAX_ATTEMPTS", "2")
    monkeypatch.setenv("WATSONX_RETRY_DELAY_SECONDS", "0")
    monkeypatch.setattr(watsonx_client.httpx, "post", fake_post)

    with pytest.raises(RuntimeError) as exc_info:
        watsonx_client._post_with_retry(
            "https://example.com",
            timeout_seconds=7,
            error_label="watsonx ordinance retrieval",
            json={"hello": "world"},
        )

    message = str(exc_info.value)
    assert "watsonx ordinance retrieval timed out" in message
    assert "attempt 2/2" in message


def test_generate_watsonx_analysis_retries_chat_call(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}

    def fake_post(url: str, timeout: float, **kwargs):
        if "identity/token" in url:
            return FakeResponse({"access_token": "token-123"})

        attempts["count"] += 1
        if attempts["count"] == 1:
            raise watsonx_client.httpx.ReadTimeout("timed out")

        return FakeResponse(
            {
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"decision":"conditional","summary":"Retry succeeded.",'
                                '"required_permits":["Health Permit"],'
                                '"follow_up_questions":[],"warnings":[]}'
                            )
                        }
                    }
                ]
            }
        )

    monkeypatch.setenv("WATSONX_API_KEY", "demo-key")
    monkeypatch.setenv("WATSONX_URL", "https://example.ibm.com")
    monkeypatch.setenv("WATSONX_PROJECT_ID", "project-123")
    monkeypatch.setenv("WATSONX_MODEL_ID", "model-123")
    monkeypatch.setenv("WATSONX_MAX_ATTEMPTS", "2")
    monkeypatch.setenv("WATSONX_RETRY_DELAY_SECONDS", "0")
    monkeypatch.setattr(watsonx_client.httpx, "post", fake_post)

    result = watsonx_client.generate_watsonx_analysis(
        project_description="Open a bakery.",
        district="mixed-use-core",
        citation_excerpts=["Home occupation bakeries require review."],
        missing_fields=[],
    )

    assert result["decision"] == "conditional"
    assert result["required_permits"] == ["Health Permit"]
    assert attempts["count"] == 2
