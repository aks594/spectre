import os
from typing import Optional, Generator

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
import asyncio

STT_CONNECTIONS: set[WebSocket] = set()

from llm_pipeline import (
    SessionState,
    summarize_resume,
    summarize_jd,
    stream_answer,
    stream_vision_answer,
)
from services.llm_service import (
    generate_stream_answer,
    generate_stream_summary,
    set_session_provider,
)

load_dotenv()

app = FastAPI(title="InterviewAI Backend", version="0.1.0")

# Allow browser clients (local dev, desktop shell) to hit the API + WebSockets
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- GLOBAL SESSION STATE ----------

CURRENT_SESSION: Optional[SessionState] = None
set_session_provider(lambda: CURRENT_SESSION)

# ---------- REQUEST MODELS ----------

class InitSessionRequest(BaseModel):
    resume_text: str = ""
    jd_text: str = ""
    company: str = "Unknown Company"
    role: str = "Candidate"
    extra_instructions: str = ""


class AskRequest(BaseModel):
    question: str


class AnalyzeRequest(BaseModel):
    image_base64: str


# ---------- ROUTES ----------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/session/init")
def init_session(req: InitSessionRequest):
    """
    Initialize a new interview session:
    - summarize resume and JD with Gemini
    - build SessionState
    """
    global CURRENT_SESSION

    resume_summary = summarize_resume(req.resume_text) if req.resume_text.strip() else ""
    jd_summary = summarize_jd(req.jd_text) if req.jd_text.strip() else ""

    CURRENT_SESSION = SessionState(
        company=req.company.strip() or "Unknown Company",
        role=req.role.strip() or "Candidate",
        jd_summary=jd_summary,
        resume_summary=resume_summary,
        extra_instructions=req.extra_instructions.strip(),
    )

    return {
        "status": "session_initialized",
        "company": CURRENT_SESSION.company,
        "role": CURRENT_SESSION.role,
        "has_resume_summary": bool(resume_summary),
        "has_jd_summary": bool(jd_summary),
    }


def _answer_stream_gen(question: str) -> Generator[bytes, None, None]:
    """
    Wraps stream_answer() and yields bytes chunks for StreamingResponse.
    """
    global CURRENT_SESSION

    if CURRENT_SESSION is None:
        msg = "No active session. Call /session/init first."
        yield msg.encode("utf-8")
        return

    # Stream chunks from Gemini
    for chunk in stream_answer(CURRENT_SESSION, question):
        if not chunk:
            continue
        # send as bytes so client can read as stream
        yield chunk.encode("utf-8")


def _vision_stream_gen(image_base64: str) -> Generator[bytes, None, None]:
    """Wraps stream_vision_answer() and yields bytes chunks for StreamingResponse."""
    global CURRENT_SESSION

    session = CURRENT_SESSION or SessionState(
        company="General",
        role="General",
        jd_summary="",
        resume_summary="",
        extra_instructions="",
    )

    for chunk in stream_vision_answer(image_base64, session):
        if not chunk:
            continue
        yield chunk.encode("utf-8")


@app.post("/ask")
def ask(req: AskRequest):
    """
    Stream an answer for a given interviewer question.
    Returns a text/plain streamed response.
    """
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    # StreamingResponse so Electron / any client can consume chunks as they arrive
    return StreamingResponse(
        _answer_stream_gen(req.question.strip()),
        media_type="text/plain",
    )


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    """Stream a vision-based answer for a screenshot encoded as base64."""
    image_data = (req.image_base64 or "").strip()
    if not image_data:
        raise HTTPException(status_code=400, detail="image_base64 cannot be empty.")

    return StreamingResponse(
        _vision_stream_gen(image_data),
        media_type="text/plain",
    )


@app.websocket("/ws/analyze")
async def ws_analyze(websocket: WebSocket):
    """Streams summary and answer for screen analysis via vision model."""
    await websocket.accept()

    async def _send_error(message: str) -> None:
        await websocket.send_json({"type": "error", "error": message})

    try:
        payload = await websocket.receive_json()
        image_base64 = (payload.get("image_base64") or payload.get("image") or "").strip()
        if not image_base64:
            await _send_error("image_base64 cannot be empty.")
            return

        session = CURRENT_SESSION or SessionState(
            company="General",
            role="General",
            jd_summary="",
            resume_summary="",
            extra_instructions="",
        )

        buffer = ""
        summary_sent = False
        separator = "---SPLIT---"

        try:
            for chunk in stream_vision_answer(image_base64, session):
                if not chunk:
                    continue
                if not summary_sent:
                    buffer += chunk
                    sep_idx = buffer.find(separator)
                    if sep_idx != -1:
                        summary_text = buffer[:sep_idx].strip()
                        remainder = buffer[sep_idx + len(separator):].lstrip()
                        summary_sent = True
                        if summary_text:
                            await websocket.send_json({"type": "summary", "chunk": summary_text})
                        if remainder:
                            await websocket.send_json({"type": "answer", "chunk": remainder})
                    continue
                await websocket.send_json({"type": "answer", "chunk": chunk})
        except Exception as stream_error:
            await _send_error(str(stream_error) or "Vision stream failed")
            return

        if not summary_sent:
            text = buffer.strip()
            if text:
                await websocket.send_json({"type": "summary", "chunk": text})

        await websocket.send_json({"type": "end", "status": "done"})

    except WebSocketDisconnect:
        return
    except Exception as e:
        await _send_error(str(e) or "Backend error")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

@app.websocket("/ws/ask")
async def ws_ask(websocket: WebSocket):
    """Streams summary + answer frames following the Stage-4 protocol."""
    await websocket.accept()

    global CURRENT_SESSION

    async def _send_error(message: str) -> None:
        await websocket.send_json({"type": "error", "error": message})

    try:
        payload = await websocket.receive_json()
        question_raw = (payload.get("question_raw") or payload.get("question") or "").strip()
        question_clean = (payload.get("question_clean") or question_raw).strip()
        metadata = payload.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}

        if not question_clean:
            await _send_error("Question cannot be empty.")
            return

        if CURRENT_SESSION is None:
            await _send_error("No session initialized. Call /session/init first.")
            return

        try:
            async for summary_chunk in generate_stream_summary(question_clean):
                if summary_chunk:
                    await websocket.send_json({"type": "summary", "chunk": summary_chunk})
        except Exception as summary_error:
            await _send_error(str(summary_error) or "Failed to summarize question.")
            return

        await websocket.send_json({"type": "summary_done"})

        try:
            async for answer_chunk in generate_stream_answer(question_clean, question_raw, metadata):
                if answer_chunk:
                    await websocket.send_json({"type": "answer", "chunk": answer_chunk})
        except Exception as answer_error:
            await _send_error(str(answer_error) or "Failed to stream answer.")
            return

        await websocket.send_json({"type": "end", "status": "done"})

    except WebSocketDisconnect:
        print("WS client disconnected.")
    except Exception as e:
        await _send_error(str(e) or "Backend error")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

async def broadcast_stt(text: str):
    """
    Send a transcript chunk to all connected /ws/stt clients.
    """
    if not STT_CONNECTIONS:
        return

    dead = set()
    payload = {"text": text}
    for ws in STT_CONNECTIONS:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)

    for ws in dead:
        STT_CONNECTIONS.discard(ws)

@app.websocket("/ws/stt")
async def ws_stt(websocket: WebSocket):
    """
    Electron UI connects here to receive live STT text.
    Python STT engine calls /stt/push, which broadcasts to all connected clients.
    """
    await websocket.accept()
    STT_CONNECTIONS.add(websocket)
    try:
        while True:
            # We don't expect messages from the UI; just keep the connection alive.
            await websocket.receive_text()
    except WebSocketDisconnect:
        STT_CONNECTIONS.discard(websocket)
    except Exception:
        STT_CONNECTIONS.discard(websocket)

class STTPushRequest(BaseModel):
    text: str

@app.post("/stt/push")
async def stt_push(req: STTPushRequest):
    """
    Called by the STT engine whenever a new transcript chunk is ready.
    Broadcasts the text to all /ws/stt listeners (Electron UI).
    """
    text = req.text.strip()
    if not text:
        return {"status": "ignored"}

    await broadcast_stt(text)
    return {"status": "ok"}
