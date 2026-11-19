"""Optional connector to a locally running Ollama server (loopback only, no cloud models).

Ollama models are offered as ready-to-use LLMs alongside the MLX shelf, and are the local agent
engine on Windows and Linux. Ollama owns its own storage: nothing here deletes Ollama models, and
`pull` downloads only when the creator asks for a recommended model (see local_agents).
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

import httpx
from pydantic import Field

PREFIX = "ollama:"
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}")
DEFAULT_HOST = "http://127.0.0.1:11434"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
MAX_IMAGE_BYTES = 20 * 1024**2
MAX_OUTPUT_CHARS = 1_000_000

# Request schema for every LLM choice: the two MLX shelf models or any local Ollama model.
LlmId = Annotated[
    str,
    Field(pattern=r"^(qwen-small|qwen-large|ollama:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199})$"),
]


class OllamaError(Exception):
    pass


class OllamaRefused(OllamaError):
    """The server answered but rejected this request (for example an unsupported option)."""


def is_ollama(identifier: str) -> bool:
    return isinstance(identifier, str) and identifier.startswith(PREFIX)


def model_name(identifier: str) -> str:
    name = identifier[len(PREFIX) :] if is_ollama(identifier) else ""
    if not NAME.fullmatch(name) or ".." in name:
        raise OllamaError("Invalid Ollama model name.")
    return name


def base_url() -> str:
    """OLLAMA_HOST is honoured only when it points at this machine; prompts never leave it."""
    raw = os.environ.get("OLLAMA_HOST", "").strip()
    if not raw:
        return DEFAULT_HOST
    if "://" not in raw:
        raw = "http://" + raw
    try:
        parts = urlsplit(raw)
        host, port = parts.hostname, parts.port or 11434
    except ValueError:
        return DEFAULT_HOST
    if parts.scheme != "http" or host not in LOOPBACK or parts.path not in {"", "/"}:
        return DEFAULT_HOST
    return f"http://{'[::1]' if host == '::1' else host}:{port}"


def is_remote(entry: dict) -> bool:
    # Ollama "cloud" models proxy prompts to ollama.com; they would break the local-only promise.
    name = str(entry.get("name") or entry.get("model") or "")
    return bool(entry.get("remote_host") or entry.get("remote_model")) or bool(
        re.search(r"(^|[-:])cloud($|[-:])", name)
    )


class Ollama:
    def __init__(self, url: str | None = None, *, cache_seconds: float = 5.0, transport=None):
        self._url = url
        self._transport = transport
        self._cache_seconds = cache_seconds
        self._lock = threading.Lock()
        self._listing: tuple[float, dict] | None = None
        self._capabilities: dict[str, list[str]] = {}
        # Token counts of the last chat on this thread, for receipts.
        self._usage = threading.local()

    @property
    def url(self) -> str:
        return self._url or base_url()

    def _client(self, timeout: float | httpx.Timeout) -> httpx.Client:
        # trust_env=False: never route loopback traffic through a configured HTTP proxy.
        return httpx.Client(
            base_url=self.url,
            timeout=timeout,
            trust_env=False,
            follow_redirects=False,
            transport=self._transport,
        )

    def status(self, *, force: bool = False) -> dict:
        """{"running": bool, "models": [...]} — cached briefly because the UI polls."""
        with self._lock:
            if not force and self._listing and time.monotonic() < self._listing[0]:
                return self._listing[1]
            try:
                with self._client(1.5) as client:
                    response = client.get("/api/tags")
                    response.raise_for_status()
                    entries = response.json().get("models", [])
                    if not isinstance(entries, list):
                        raise TypeError("Invalid Ollama listing")
                    models = []
                    for entry in entries[:200]:
                        if not isinstance(entry, dict) or is_remote(entry):
                            continue
                        name = entry.get("name") or entry.get("model")
                        if not isinstance(name, str) or not NAME.fullmatch(name) or ".." in name:
                            continue
                        key = f"{name}@{entry.get('digest', '')}"
                        if key not in self._capabilities:
                            self._capabilities[key] = self._show(client, name)
                        capabilities = self._capabilities[key]
                        if "completion" not in capabilities:
                            continue  # embedding-only models cannot write hooks or captions
                        size = entry.get("size")
                        details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
                        models.append(
                            {
                                "name": name,
                                "size": size if type(size) is int and size > 0 else None,
                                "vision": "vision" in capabilities,
                                "thinking": "thinking" in capabilities,
                                "parameter_size": str(details.get("parameter_size", ""))[:32],
                                "quantization": str(details.get("quantization_level", ""))[:32],
                            }
                        )
                value = {"running": True, "models": models}
            except (httpx.HTTPError, ValueError, TypeError, AttributeError):
                value = {"running": False, "models": []}
            self._listing = (time.monotonic() + self._cache_seconds, value)
            return value

    @staticmethod
    def _show(client: httpx.Client, name: str) -> list[str]:
        try:
            response = client.post("/api/show", json={"model": name}, timeout=5)
            response.raise_for_status()
            capabilities = response.json().get("capabilities")
        except (httpx.HTTPError, ValueError, AttributeError):
            capabilities = None
        if not isinstance(capabilities, list):
            # Older Ollama builds omit capabilities; assume text completion only.
            return ["completion"]
        return [c for c in capabilities if isinstance(c, str)]

    def model(self, name: str) -> dict | None:
        return next((m for m in self.status()["models"] if m["name"] == name), None)

    def unload(self, name: str) -> None:
        """Release warm local weights without doing another inference."""
        if not NAME.fullmatch(name) or ".." in name:
            raise OllamaError("Invalid Ollama model name.")
        try:
            with self._client(5) as client:
                response = client.post("/api/generate", json={"model": name, "keep_alive": 0})
                response.raise_for_status()
        except httpx.HTTPError:
            raise OllamaError("Could not release the local model. Check Ollama memory usage.") from None

    def generate(
        self,
        name: str,
        prompt: str,
        *,
        images: list[str] | None = None,
        image_labels: list[str] | None = None,
        schema: dict | None = None,
        temperature: float = 0.3,
        max_tokens: int = 1500,
        check=lambda: None,
        keep_alive: int | str = 0,
        context_tokens: int | None = None,
    ) -> str:
        """Stream a chat completion so cancellation is honoured between chunks."""
        info = self.model(name)
        if info is None:
            raise OllamaError("This Ollama model is no longer available. Refresh Models.")
        images = images or []
        if images and not info["vision"]:
            raise OllamaError(
                "This Ollama model cannot read images, and clip analysis sends video frames. "
                "Choose a vision-capable model (for example a Qwen VL or Qwen3.5+ build)."
            )
        encoded = []
        for image in images:
            path = Path(image)
            if not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
                raise OllamaError("Frames must be local image files.")
            encoded.append(base64.b64encode(path.read_bytes()).decode("ascii"))
        if encoded and image_labels:
            # The chat API attaches images to the message rather than interleaving them with text.
            order = "; ".join(f"image {i + 1} is the {label}" for i, label in enumerate(image_labels))
            prompt = f"The attached images are in order: {order}.\n{prompt}"
        message = {"role": "user", "content": prompt}
        if encoded:
            message["images"] = encoded
        body = {
            "model": name,
            "messages": [message],
            "stream": True,
            # Default: unload after the task, like the MLX worker, so Whisper/Kokoro get the memory.
            # Multi-call runs (batches, agent swarms) pass a duration to avoid reloading weights per call.
            "keep_alive": keep_alive,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        if context_tokens is not None:
            if type(context_tokens) is not int or not 2048 <= context_tokens <= 16384:
                raise OllamaError("Local context size must be between 2048 and 16384 tokens.")
            body["options"]["num_ctx"] = context_tokens
        if info["thinking"]:
            body["think"] = False
        if schema is not None:
            body["format"] = schema
        try:
            return self._chat(body, check)
        except OllamaRefused:
            if schema is None:
                raise
            # Older builds or unsupported schema keywords: retry unconstrained, validate downstream.
            body.pop("format")
            return self._chat(body, check)

    def usage(self) -> dict:
        """{prompt_tokens, completion_tokens} that Ollama reported for this thread's last chat."""
        return dict(getattr(self._usage, "value", None) or {"prompt_tokens": 0, "completion_tokens": 0})

    def _chat(self, body: dict, check) -> str:
        chunks: list[str] = []
        total = 0
        self._usage.value = None
        timeout = httpx.Timeout(1800, connect=3)
        try:
            with self._client(timeout) as client, client.stream("POST", "/api/chat", json=body) as response:
                if response.status_code != 200:
                    response.read()
                    raise OllamaRefused(f"Ollama refused the request (HTTP {response.status_code}).")
                for line in response.iter_lines():
                    check()
                    if not line:
                        continue
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise TypeError("Invalid Ollama event")
                    if event.get("error"):
                        raise OllamaError(f"Ollama error: {str(event['error'])[:300]}")
                    content = (event.get("message") or {}).get("content", "")
                    if not isinstance(content, str):
                        raise TypeError("Invalid Ollama content")
                    total += len(content)
                    if total > MAX_OUTPUT_CHARS:
                        raise OllamaError("Ollama output exceeded the size limit.")
                    chunks.append(content)
                    if event.get("done"):
                        counts = [event.get("prompt_eval_count"), event.get("eval_count")]
                        self._usage.value = {
                            "prompt_tokens": counts[0] if type(counts[0]) is int else 0,
                            "completion_tokens": counts[1] if type(counts[1]) is int else 0,
                        }
                        break
        except httpx.ConnectError as exc:
            raise OllamaError("Ollama is not running. Open the Ollama app or run `ollama serve`.") from exc
        except (httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
            raise OllamaError("Ollama returned an invalid or interrupted response.") from exc
        return "".join(chunks)

    def pull(self, name: str, *, progress, check=lambda: None) -> None:
        """Download a model through Ollama, reporting progress(percent 0..95, message); cancellable."""
        if not NAME.fullmatch(name) or ".." in name:
            raise OllamaError("Invalid Ollama model name.")
        layers: dict[str, tuple[int, int]] = {}
        last = -1
        finished = False
        try:
            with self._client(httpx.Timeout(7200, connect=3)) as client, client.stream(
                "POST", "/api/pull", json={"model": name, "stream": True}
            ) as response:
                if response.status_code != 200:
                    response.read()
                    raise OllamaError(f"Ollama refused the download (HTTP {response.status_code}).")
                for line in response.iter_lines():
                    check()
                    if not line:
                        continue
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise TypeError("Invalid Ollama event")
                    if event.get("error"):
                        raise OllamaError(f"Ollama could not download this model: {str(event['error'])[:300]}")
                    state = str(event.get("status") or "")[:80]
                    if state == "success":
                        finished = True
                        break
                    digest, size, done = event.get("digest"), event.get("total"), event.get("completed")
                    if isinstance(digest, str) and type(size) is int and size > 0:
                        layers[digest] = (size, min(size, done) if type(done) is int and done > 0 else 0)
                    total = sum(size for size, _ in layers.values())
                    received = sum(done for _, done in layers.values())
                    percent = min(95, round(received / total * 95)) if total else 0
                    if percent != last:
                        last = percent
                        message = (
                            f"Downloading through Ollama ({received / 1e9:.1f} of {total / 1e9:.1f} GB)"
                            if total else f"Ollama: {state or 'starting'}"
                        )
                        progress(percent, message)
        except httpx.ConnectError as exc:
            raise OllamaError("Ollama is not running. Open the Ollama app or run `ollama serve`.") from exc
        except (httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
            raise OllamaError("Ollama's download stopped or returned an invalid response. Try again.") from exc
        finally:
            with self._lock:
                self._listing = None
        if not finished:
            raise OllamaError("Ollama's download ended before it finished. Try again.")
