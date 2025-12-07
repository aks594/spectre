from __future__ import annotations

import asyncio
import threading
from typing import AsyncGenerator, Callable, Dict, Iterable, Optional, Tuple

from llm_pipeline import (
    MODEL_NAME,
    SessionState,
    stream_answer as sync_stream_answer,
    groq_client,
)

SessionProvider = Callable[[], Optional[SessionState]]
_SESSION_PROVIDER: Optional[SessionProvider] = None

SUMMARY_PROMPT = """
You receive an interviewer question and must rewrite it as a short, direct summary
(1 tight sentence, max 30 words). Keep the intent intact, no filler.
Question:
"{question}"
"""

def set_session_provider(provider: SessionProvider) -> None:
    """Registers a callback that returns the current SessionState."""
    global _SESSION_PROVIDER
    _SESSION_PROVIDER = provider


def _get_session() -> SessionState:
    if not _SESSION_PROVIDER:
        raise RuntimeError("Session provider not configured.")
    session = _SESSION_PROVIDER()
    if session is None:
        raise RuntimeError("No active interview session.")
    return session


def _chunk_text(text: str, min_len: int = 20, max_len: int = 60) -> Iterable[str]:
    words = text.split()
    if not words:
        return

    chunk_words: list[str] = []
    current_len = 0
    for word in words:
        chunk_words.append(word)
        current_len += len(word) + 1  # include space
        if current_len >= max_len:
            yield " ".join(chunk_words).strip()
            chunk_words = []
            current_len = 0

    if chunk_words:
        residual = " ".join(chunk_words).strip()
        if residual:
            yield residual


async def generate_stream_summary(question_clean: str) -> AsyncGenerator[str, None]:
    question = (question_clean or "").strip()
    if not question:
        return

    def _generate_summary() -> str:
        response = groq_client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "user", "content": SUMMARY_PROMPT.format(question=question)}],
            temperature=0.2,
            max_tokens=120,
        )
        return response.choices[0].message.content

    summary_text = await asyncio.to_thread(_generate_summary)
    if not summary_text:
        return

    for chunk in _chunk_text(summary_text):
        yield chunk


async def generate_stream_answer(
    question_clean: str,
    question_raw: str,
    metadata: Optional[Dict[str, object]] = None,
) -> AsyncGenerator[str, None]:
    """Wraps the synchronous stream_answer in an async generator."""
    question_text = (question_clean or question_raw or "").strip()
    if not question_text:
        raise RuntimeError("Question text is required.")

    session = _get_session()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Tuple[object, Optional[BaseException]]] = asyncio.Queue()
    END = object()

    def _worker() -> None:
        try:
            for chunk in sync_stream_answer(session, question_text):
                if chunk:
                    loop.call_soon_threadsafe(queue.put_nowait, (chunk, None))
        except BaseException as exc:  # propagate to async context
            loop.call_soon_threadsafe(queue.put_nowait, ("", exc))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, (END, None))

    threading.Thread(target=_worker, daemon=True).start()

    while True:
        chunk, exc = await queue.get()
        if chunk is END:
            break
        if exc:
            raise exc
        if chunk:
            yield chunk

    # metadata currently unused but accepted for future enrichment
    _ = metadata
