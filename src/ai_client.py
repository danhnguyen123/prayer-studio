"""LLM client layer.

Two concrete clients sharing a common interface:
  - AnthropicClient  : uses the official `anthropic` SDK (claude.ai endpoint).
  - DeepSeekClient   : calls DeepSeek's native /chat/completions.
  - OpenAIResponsesClient: calls the official OpenAI Responses or Batch API.
  - KieResponsesClient: calls Kie's Responses-compatible API for GPT-5.6 Terra.

Both expose:
  - complete_messages(messages, model=None, max_tokens=..., system=None, ...) -> str
  - complete(blocks, ...) -> str   (convenience: wraps blocks into one user turn)

Anthropic-style content blocks (list of {"type":"text","text":..., optional cache_control})
are the canonical input. DeepSeekClient flattens blocks to a plain string and silently
drops cache_control markers (DeepSeek has automatic server-side caching with no markers).
"""
from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from itertools import cycle
from typing import Any

import anthropic
import requests


# =============================================================================
# Base interface
# =============================================================================
class BaseClient(ABC):
    """Common interface every provider client implements."""

    provider: str = ""
    default_model: str = ""
    supports_cache_control: bool = False

    @abstractmethod
    def complete_messages(
        self,
        messages: list[dict],
        model: str | None = None,
        max_tokens: int = 8000,
        system: str | None = None,
        max_retries: int = 3,
    ) -> str: ...

    def complete(
        self,
        blocks: list[dict],
        model: str | None = None,
        max_tokens: int = 8000,
        system: str | None = None,
        max_retries: int = 3,
    ) -> str:
        return self.complete_messages(
            messages=[{"role": "user", "content": blocks}],
            model=model,
            max_tokens=max_tokens,
            system=system,
            max_retries=max_retries,
        )


# =============================================================================
# Anthropic
# =============================================================================
class AnthropicClient(BaseClient):
    """Uses the official Anthropic SDK against https://api.anthropic.com."""

    provider = "anthropic"
    supports_cache_control = True

    def __init__(self, api_keys: list[str], default_model: str = "claude-opus-4-7"):
        if not api_keys:
            raise ValueError("api_keys must not be empty")
        self.default_model = default_model
        self._keys = list(api_keys)
        self._key_cycle = cycle(self._keys)
        self._current_key = next(self._key_cycle)
        self._client = anthropic.Anthropic(api_key=self._current_key)

    def _rotate(self):
        self._current_key = next(self._key_cycle)
        self._client = anthropic.Anthropic(api_key=self._current_key)

    def complete_messages(self, messages, model=None, max_tokens=8000, system=None, max_retries=3):
        model = model or self.default_model
        last_err: Exception | None = None
        for attempt in range(max_retries):
            try:
                kwargs: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": messages}
                if system:
                    kwargs["system"] = system
                resp = self._client.messages.create(**kwargs)
                return "".join(b.text for b in resp.content if b.type == "text")
            except anthropic.AuthenticationError as e:
                last_err = e
                if len(self._keys) > 1:
                    self._rotate()
                    continue
                raise
            except (anthropic.RateLimitError, anthropic.APIStatusError) as e:
                last_err = e
                time.sleep(2 ** attempt)
                if len(self._keys) > 1:
                    self._rotate()
                continue
            except anthropic.APIConnectionError as e:
                last_err = e
                time.sleep(2 ** attempt)
                continue
        raise RuntimeError(f"AnthropicClient failed after {max_retries} retries: {last_err}")


# =============================================================================
# DeepSeek (native /chat/completions, OpenAI-compatible)
# =============================================================================
class DeepSeekClient(BaseClient):
    """Calls DeepSeek native API directly via `requests`. No anthropic SDK involved.

    Docs:
      - API ref: https://api-docs.deepseek.com/
      - Multi-round chat: https://api-docs.deepseek.com/guides/multi_round_chat
      - Context caching (KV): https://api-docs.deepseek.com/guides/kv_cache

    Endpoint: POST https://api.deepseek.com/chat/completions
    Auth: Authorization: Bearer <api_key>
    Models (per current docs, as of 2025-2026):
      - "deepseek-v4-pro"   : main model, recommended for writing.
      - "deepseek-v4-flash" : smaller / faster / cheaper variant.
      ("deepseek-chat" and "deepseek-reasoner" → deprecated on 2026/07/24.)

    Context caching: DeepSeek automatically caches prefixes that match between
    requests within a short window (server-side KV cache). No client-side marker
    needed — we just keep the prefix (persona DNA header) byte-identical across
    requests within a script, which our pipeline already does. So the same
    pipeline that benefits Claude prompt caching also benefits DeepSeek KV cache.
    """

    provider = "deepseek"
    supports_cache_control = False           # No client-side marker, but server auto-caches.
    BASE_URL = "https://api.deepseek.com"

    def __init__(
        self,
        api_keys: list[str],
        default_model: str = "deepseek-v4-pro",
        base_url: str | None = None,
        timeout: float = 300.0,
    ):
        if not api_keys:
            raise ValueError("api_keys must not be empty")
        self.default_model = default_model
        self._keys = list(api_keys)
        self._key_cycle = cycle(self._keys)
        self._current_key = next(self._key_cycle)
        self._base_url = (base_url or self.BASE_URL).rstrip("/")
        self._timeout = timeout
        self._session = requests.Session()

    def _rotate(self):
        self._current_key = next(self._key_cycle)

    @staticmethod
    def _flatten_content(content: Any) -> str:
        """Anthropic-style content (list of blocks) → OpenAI-style plain string.

        Critical for caching: this must be deterministic. Given the same input
        blocks, it must always produce the same string, so DeepSeek's server-side
        KV cache can detect a matching prefix.
        """
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    parts.append(block)
            return "\n".join(parts)
        return str(content)

    def _to_openai_messages(self, messages: list[dict], system: str | None) -> list[dict]:
        out: list[dict] = []
        if system:
            out.append({"role": "system", "content": system})
        for msg in messages:
            out.append({
                "role": msg["role"],
                "content": self._flatten_content(msg["content"]),
            })
        return out

    def complete_messages(self, messages, model=None, max_tokens=8000, system=None, max_retries=3):
        model = model or self.default_model
        payload = {
            "model": model,
            "messages": self._to_openai_messages(messages, system=system),
            "max_tokens": max_tokens,
            "stream": False,
        }
        url = f"{self._base_url}/chat/completions"

        last_err: Exception | None = None
        for attempt in range(max_retries):
            try:
                resp = self._session.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self._current_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=self._timeout,
                )

                # Auth error — try next key if available.
                if resp.status_code == 401:
                    last_err = RuntimeError(f"401 Unauthorized: {resp.text[:300]}")
                    if len(self._keys) > 1:
                        self._rotate()
                        continue
                    raise last_err

                # Rate limit / server error — backoff + rotate.
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_err = RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
                    time.sleep(2 ** attempt)
                    if len(self._keys) > 1:
                        self._rotate()
                    continue

                resp.raise_for_status()
                data = resp.json()
                # OpenAI-compat shape: choices[0].message.content
                return data["choices"][0]["message"]["content"]

            except (requests.Timeout, requests.ConnectionError) as e:
                last_err = e
                time.sleep(2 ** attempt)
                continue
            except requests.HTTPError as e:
                last_err = e
                time.sleep(2 ** attempt)
                continue
            except (KeyError, ValueError) as e:
                # Malformed response.
                last_err = e
                time.sleep(2 ** attempt)
                continue

        raise RuntimeError(f"DeepSeekClient failed after {max_retries} retries: {last_err}")


# =============================================================================
# Kie Responses API (GPT-5.6 Terra)
# =============================================================================
class KieResponsesClient(BaseClient):
    """Calls https://api.kie.ai/codex/v1/responses using a Responses-style payload."""

    provider = "kie"
    supports_cache_control = False
    BASE_URL = "https://api.kie.ai/codex/v1/responses"

    def __init__(
        self,
        api_keys: list[str],
        default_model: str = "gpt-5-6-terra",
        reasoning_effort: str = "medium",
        endpoint: str | None = None,
        timeout: float = 600.0,
    ):
        if not api_keys:
            raise ValueError("api_keys must not be empty")
        self.default_model = default_model
        self.reasoning_effort = reasoning_effort
        self._keys = list(api_keys)
        self._key_cycle = cycle(self._keys)
        self._current_key = next(self._key_cycle)
        self._endpoint = endpoint or self.BASE_URL
        self._timeout = timeout
        self._session = requests.Session()

    def _rotate(self):
        self._current_key = next(self._key_cycle)

    @staticmethod
    def _flatten_content(content: Any) -> str:
        return DeepSeekClient._flatten_content(content)

    def _to_responses_input(self, messages: list[dict]) -> list[dict]:
        items = []
        for message in messages:
            role = message["role"]
            content_type = "output_text" if role == "assistant" else "input_text"
            items.append({
                "role": role,
                "content": [{
                    "type": content_type,
                    "text": self._flatten_content(message["content"]),
                }],
            })
        return items

    @staticmethod
    def _extract_output_text(data: dict) -> str:
        chunks: list[str] = []
        for item in data.get("output", []):
            if item.get("type") != "message" or item.get("role") != "assistant":
                continue
            for block in item.get("content", []):
                if block.get("type") == "output_text":
                    chunks.append(block.get("text", ""))
        return "".join(chunks).strip()

    @classmethod
    def _parse_response_body(cls, body: str) -> dict:
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            pass

        payloads: list[dict] = []
        deltas: list[str] = []
        completed_texts: list[str] = []
        for line in body.splitlines():
            if not line.startswith("data:"):
                continue
            raw = line[5:].strip()
            if not raw or raw == "[DONE]":
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            candidate = event.get("response", event)
            if isinstance(candidate, dict) and isinstance(candidate.get("output"), list):
                payloads.append(candidate)
            if event.get("type") == "response.output_text.delta" and isinstance(event.get("delta"), str):
                deltas.append(event["delta"])
            if event.get("type") == "response.output_text.done" and isinstance(event.get("text"), str):
                completed_texts.append(event["text"])

        for payload in reversed(payloads):
            if cls._extract_output_text(payload):
                return payload
        text = completed_texts[-1] if completed_texts else "".join(deltas)
        if text:
            return {
                "status": "completed",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }],
            }
        if payloads:
            return payloads[-1]
        raise ValueError("Response is neither valid JSON nor Responses SSE")

    def complete_messages(self, messages, model=None, max_tokens=8000, system=None, max_retries=3):
        payload: dict[str, Any] = {
            "model": model or self.default_model,
            "input": self._to_responses_input(messages),
            "reasoning": {"effort": self.reasoning_effort},
            "max_output_tokens": max_tokens,
        }
        if system:
            payload["instructions"] = system

        last_err: Exception | None = None
        for attempt in range(max_retries):
            try:
                response = self._session.post(
                    self._endpoint,
                    headers={
                        "Authorization": f"Bearer {self._current_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=self._timeout,
                )
                if response.status_code == 401:
                    last_err = RuntimeError(f"401 Unauthorized: {response.text[:300]}")
                    if len(self._keys) > 1:
                        self._rotate()
                        continue
                    raise last_err
                if response.status_code == 429 or response.status_code >= 500:
                    last_err = RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
                    time.sleep(2 ** attempt)
                    if len(self._keys) > 1:
                        self._rotate()
                    continue
                response.raise_for_status()
                data = self._parse_response_body(response.text)
                text = self._extract_output_text(data)
                if not text:
                    raise ValueError(
                        f"Kie response has no output_text (status={data.get('status', 'unknown')})"
                    )
                return text
            except (requests.Timeout, requests.ConnectionError, requests.HTTPError, ValueError) as e:
                last_err = e
                time.sleep(2 ** attempt)
                continue

        raise RuntimeError(f"KieResponsesClient failed after {max_retries} retries: {last_err}")


# =============================================================================
# Official OpenAI Responses + Batch API (GPT-5.6 Terra)
# =============================================================================
class OpenAIResponsesClient(KieResponsesClient):
    """Calls the official OpenAI API, optionally using the 24h Batch API."""

    provider = "openai"
    BASE_URL = "https://api.openai.com/v1"

    def __init__(
        self,
        api_keys: list[str],
        default_model: str = "gpt-5.6-terra",
        reasoning_effort: str = "medium",
        processing_mode: str = "standard",
        base_url: str | None = None,
        timeout: float = 600.0,
    ):
        if processing_mode not in {"standard", "batch"}:
            raise ValueError(f"Unsupported OpenAI processing mode: {processing_mode}")
        root = (base_url or self.BASE_URL).rstrip("/")
        super().__init__(
            api_keys=api_keys,
            default_model=default_model,
            reasoning_effort=reasoning_effort,
            endpoint=f"{root}/responses",
            timeout=timeout,
        )
        self._base_url = root
        self.processing_mode = processing_mode

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._current_key}",
            "Content-Type": "application/json",
        }

    def _response_payload(self, messages, model, max_tokens, system) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model or self.default_model,
            "input": self._to_responses_input(messages),
            "reasoning": {"effort": self.reasoning_effort},
            "max_output_tokens": max_tokens,
            "store": False,
        }
        if system:
            payload["instructions"] = system
        return payload

    def _standard_complete(self, payload: dict, max_retries: int) -> str:
        last_err: Exception | None = None
        for attempt in range(max_retries):
            try:
                response = self._session.post(
                    self._endpoint,
                    headers=self._headers(),
                    json=payload,
                    timeout=self._timeout,
                )
                if response.status_code == 401:
                    last_err = RuntimeError(f"401 Unauthorized: {response.text[:300]}")
                    if len(self._keys) > 1:
                        self._rotate()
                        continue
                    raise last_err
                if response.status_code == 429 or response.status_code >= 500:
                    last_err = RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
                    time.sleep(2 ** attempt)
                    if len(self._keys) > 1:
                        self._rotate()
                    continue
                response.raise_for_status()
                data = response.json()
                text = self._extract_output_text(data)
                if not text:
                    raise ValueError(
                        f"OpenAI response has no output_text (status={data.get('status', 'unknown')})"
                    )
                return text
            except (requests.Timeout, requests.ConnectionError, requests.HTTPError, ValueError) as exc:
                last_err = exc
                time.sleep(2 ** attempt)
        raise RuntimeError(f"OpenAIResponsesClient failed after {max_retries} retries: {last_err}")

    def _batch_complete(self, payload: dict) -> str:
        request_line = json.dumps({
            "custom_id": "prayer-rewrite",
            "method": "POST",
            "url": "/v1/responses",
            "body": payload,
        }, ensure_ascii=False)
        upload = self._session.post(
            f"{self._base_url}/files",
            headers={"Authorization": f"Bearer {self._current_key}"},
            data={"purpose": "batch"},
            files={"file": ("prayer-rewrite.jsonl", request_line.encode("utf-8"), "application/jsonl")},
            timeout=self._timeout,
        )
        upload.raise_for_status()
        input_file_id = upload.json()["id"]

        created = self._session.post(
            f"{self._base_url}/batches",
            headers=self._headers(),
            json={
                "input_file_id": input_file_id,
                "endpoint": "/v1/responses",
                "completion_window": "24h",
                "metadata": {"workflow": "prayer-rewrite"},
            },
            timeout=self._timeout,
        )
        created.raise_for_status()
        batch = created.json()
        batch_id = batch["id"]
        print(f"[openai-batch] Submitted {batch_id}; waiting for completion...")

        deadline = time.monotonic() + (25 * 60 * 60)
        while batch.get("status") not in {"completed", "failed", "expired", "cancelled"}:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"OpenAI Batch {batch_id} exceeded the 25-hour local wait limit")
            time.sleep(10)
            status_response = self._session.get(
                f"{self._base_url}/batches/{batch_id}",
                headers=self._headers(),
                timeout=self._timeout,
            )
            status_response.raise_for_status()
            batch = status_response.json()
            counts = batch.get("request_counts", {})
            print(
                f"[openai-batch] {batch.get('status')} "
                f"{counts.get('completed', 0)}/{counts.get('total', 1)}"
            )

        if batch.get("status") != "completed" or not batch.get("output_file_id"):
            raise RuntimeError(
                f"OpenAI Batch {batch_id} ended as {batch.get('status')}: {batch.get('errors')}"
            )
        output = self._session.get(
            f"{self._base_url}/files/{batch['output_file_id']}/content",
            headers=self._headers(),
            timeout=self._timeout,
        )
        output.raise_for_status()
        for line in output.text.splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            if item.get("custom_id") != "prayer-rewrite":
                continue
            if item.get("error") or item.get("response", {}).get("status_code", 500) >= 400:
                raise RuntimeError(f"OpenAI Batch item failed: {item.get('error') or item.get('response')}")
            data = item["response"]["body"]
            text = self._extract_output_text(data)
            if text:
                return text
        raise RuntimeError(f"OpenAI Batch {batch_id} returned no output_text")

    def complete_messages(self, messages, model=None, max_tokens=8000, system=None, max_retries=3):
        payload = self._response_payload(messages, model, max_tokens, system)
        if self.processing_mode == "batch":
            return self._batch_complete(payload)
        return self._standard_complete(payload, max_retries)


# =============================================================================
# Factory
# =============================================================================
PROVIDER_DEFAULT_MODELS = {
    "anthropic": "claude-opus-4-7",
    "deepseek": "deepseek-v4-pro",
    "kie": "gpt-5-6-terra",
    "openai": "gpt-5.6-terra",
}


def make_client(
    provider: str,
    api_keys: list[str],
    default_model: str | None = None,
    reasoning_effort: str = "medium",
    processing_mode: str = "standard",
) -> BaseClient:
    if provider == "anthropic":
        return AnthropicClient(
            api_keys=api_keys,
            default_model=default_model or PROVIDER_DEFAULT_MODELS["anthropic"],
        )
    if provider == "deepseek":
        return DeepSeekClient(
            api_keys=api_keys,
            default_model=default_model or PROVIDER_DEFAULT_MODELS["deepseek"],
        )
    if provider == "kie":
        return KieResponsesClient(
            api_keys=api_keys,
            default_model=default_model or PROVIDER_DEFAULT_MODELS["kie"],
            reasoning_effort=reasoning_effort,
        )
    if provider == "openai":
        return OpenAIResponsesClient(
            api_keys=api_keys,
            default_model=default_model or PROVIDER_DEFAULT_MODELS["openai"],
            reasoning_effort=reasoning_effort,
            processing_mode=processing_mode,
        )
    raise ValueError(
        f"Unknown provider: {provider}. Supported: {list(PROVIDER_DEFAULT_MODELS)}"
    )


# =============================================================================
# Helpers used by train.py / generate.py
# =============================================================================
def text_block(text: str, cache: bool = False) -> dict:
    """Create an Anthropic-style text content block.

    `cache=True` adds cache_control: ephemeral marker. Clients that don't support
    cache_control (DeepSeek) silently drop the marker when flattening.
    """
    block: dict = {"type": "text", "text": text}
    if cache:
        block["cache_control"] = {"type": "ephemeral"}
    return block


# Backward-compat aliases (older imports).
AIClient = BaseClient
ClaudeClient = AnthropicClient
