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

STT_CONNECTIONS = set()

from llm_pipeline import (
    SessionState,
    summarize_resume,
    summarize_jd,
    stream_answer,
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
STT_CONNECTIONS: set[WebSocket] = set()

# ---------- REQUEST MODELS ----------

class InitSessionRequest(BaseModel):
    resume_text: str = ""
    jd_text: str = ""
    company: str = "Unknown Company"
    role: str = "Candidate"
    extra_instructions: str = ""


class AskRequest(BaseModel):
    question: str


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

@app.websocket("/ws/ask")
async def ws_ask(websocket: WebSocket):
    """
    WebSocket endpoint:
    Client sends: { "question": "Tell me about yourself" }
    Server streams token chunks back as WebSocket text frames.
    """
    await websocket.accept()

    global CURRENT_SESSION

    try:
        while True:
            data = await websocket.receive_json()

            question = data.get("question", "").strip()
            if not question:
                await websocket.send_text("[ERROR] Question cannot be empty.")
                continue

            if CURRENT_SESSION is None:
                await websocket.send_text("[ERROR] No session initialized. Call /session/init first.")
                continue

            # Stream tokens
            for chunk in stream_answer(CURRENT_SESSION, question):
                if chunk:
                    await websocket.send_text(chunk)

            await websocket.send_text("[END]")  # mark completion

    except WebSocketDisconnect:
        print("WS client disconnected.")
    except Exception as e:
        await websocket.send_text(f"[ERROR] {str(e)}")

async def broadcast_stt(text: str):
    """
    Send a transcript chunk to all connected /ws/stt clients.
    """
    if not STT_CONNECTIONS:
        return

    dead = set()
    for ws in STT_CONNECTIONS:
        try:
            await ws.send_text(text)
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

    asyncio.create_task(broadcast_stt(text))
    return {"status": "ok"}
