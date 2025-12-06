### **InterviewAI – System Architecture Specification**

**Version:** 1.0
**Purpose:** This document defines the complete architecture for the InterviewAI desktop app (Electron-based), its backend (FastAPI + Python), STT engine, summarizer, LLM pipeline, and UI behavior.
**Copilot must follow this specification when generating any new files.**

---

# 1. Overview

InterviewAI is a **local desktop application** that mimics the workflow of ParakeetAI:

* Always-on-top transparent HUD (Command Bar)
* Live real-time transcript from STT engine
* “Answer Question” → Summarization → Overlay with streamed question → streamed answer
* Python backend running STT + LLM logic
* Electron (Node.js) powering UI windows

This app is for **personal use only** and must be efficient, minimal-latency, and unobtrusive during interviews.

---

# 2. Folder Structure (skip this)

# 3. Backend Architecture (Python + FastAPI)

### 3.1 Services

#### **1. Session Service**

Endpoint: `POST /session/init`
Stores:

* Resume summary
* Job description summary
* Company name
* Role
* Extra instructions
* Conversation memory (list of previous Q/A)

Session must live in memory (one session at a time).

---

#### **2. STT Push Service**

Endpoint: `POST /stt/push`
Payload receives: `"text": "<chunk>"`
Broadcasts to WebSocket: `ws://localhost:8000/ws/stt`

Purpose:

* Frontend HUD receives chunk
* Appends to transcript buffer (no dedupe here — frontend handles it)

---

#### **3. Summarizer Service**

Endpoint: `POST /session/summarize_question`
Input: raw full transcript text
Output: one clean interviewer question

Rules:

* Remove repetitions
* Fix broken sentences
* Only one question
* 1 sentence max

Uses: `gemini-2.0-flash`

---

#### **4. LLM Answer Streaming**

WebSocket: `/ws/ask`
Input JSON:

```
{ "question": "<summarized question>" }
```

Streams answer tokens using Gemini.

Answer is:

1. Streamed in real time
2. Added to session memory after complete
3. Should follow these rules:

   * 3–6 sentences
   * No meta text
   * Confident spoken-English tone

---

# 4. STT Engine (Python)

File: `backend/stt_engine.py`

Responsibilities:

* Capture **system audio** via WASAPI loopback (`sounddevice` + device index 16)
* 48 kHz sampling
* Send **rolling chunks** every 500–700 ms
* Call `/stt/push` with text chunks
* Use **Groq Whisper-v3** for transcription
* Language fixed to English
* Small cleanup (strip trailing punctuation)

STT engine does **not** deduplicate or summarize.
All cleanup happens in frontend + summarizer.

---

# 5. Electron App Architecture

## 5.1 Two Window Model

### **1. HUD Window (Command Bar)**

* Transparent
* Frameless
* Always-on-top
* Draggable
* Resizable scale (future)
* Shows live transcript (scrolling)
* “Answer Question” button opens overlay
* “Stop Listening” (future)
* “Exit App” (future)

File: `electron/windows/hud.html`

---

### **2. Brain Overlay Window**

Appears when clicking “Answer Question.”

* Semi-transparent dark panel
* Shows:

  * Streaming summarized question
  * Streaming answer
* Close button
* History navigation (future)
* Code block formatting
* Smart copy button

File: `electron/windows/brain.html`

---

# 5.2 IPC Paths

### HUD → Main

* `"open-brain"`
* `"close-brain"`

### HUD → Backend

Uses REST + WebSockets:

* REST: `/session/summarize_question`
* WS : `/ws/stt`
* WS : `/ws/ask`

The frontend JS uses:

```
window.electronAPI.openBrain()
```

And backend communication via fetch/WebSocket.

---

# 6. Frontend Logic (Inside Electron Windows)

## 6.1 Live Transcript Accumulator (HUD)

Global:

```
let fullTranscript = "";
```

On each STT chunk:

1. Avoid duplicating text
2. Append new chunk
3. Update HUD transcript view

Deduping rule:

```
if (!fullTranscript.endsWith(chunk)) { fullTranscript += " " + chunk; }
```

---

## 6.2 Answer Flow (HUD → Brain)

### Step 1 — User clicks **Answer Question**

HUD freezes transcript:

```
const raw = fullTranscript
```

### Step 2 — Summarization

HUD → backend:

POST `/session/summarize_question`

→ returns one clean question

### Step 3 — Open Brain overlay

```
window.electronAPI.openBrain()
```

### Step 4 — Brain streams summarized question first

Brain connects to WS:

```
ws://localhost:8000/ws/ask
```

with payload:

```
{ question: "<summarized question>" }
```

### Step 5 — After question finishes streaming, answer begins streaming

Brain UI places answer below the question.

---

# 7. UI/UX Guidelines

### HUD:

* Dark theme
* Transparent background
* White text
* Bar height ~60px
* Live transcript scrolls horizontally

### Brain Overlay:

* #1a1a1a background at 90% opacity
* Rounded corners
* Markdown rendering
* Monospace font for code
* Close button top-right

---

# 8. Build Instructions

### Backend:

```
cd backend
source ../.venv/Scripts/activate
uvicorn api_server:app --port 8000 --reload
```

### STT Engine:

```
cd backend
python stt_engine.py
```

### Electron App:

```
cd electron
npm install
npm start
```

---

# 9. Coding Rules for Copilot

Copilot MUST follow:

1. Electron windows must load HTML from `electron/windows/`
2. Every renderer file (`hud.js`, `brain.js`) must use `window.electronAPI`
3. Backend URLs must use:

   * `http://localhost:8000`
   * `ws://localhost:8000`
4. All streaming must be token-by-token, not full text
5. No external UI frameworks (pure HTML/CSS/JS unless explicitly requested)
6. All LLM prompts must follow the LLM pipeline rules
7. Summarizer returns **exactly one question**
8. HUD must NEVER block overlay
9. Brain must be hidden by default

---

# 10. Future Extensions (reserved for later)

* Screen OCR
* History navigation
* Position/scale menu
* Invisible window flags (SetWindowDisplayAffinity)
* Keybindings
* Cross-platform packaging