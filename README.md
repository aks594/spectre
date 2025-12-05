# InterviewAI (Local ParakeetAI Alternative)

A local interview assistant that:
- Listens to **system audio** via STT (Groq Whisper)
- Streams transcription to the UI (WebSocket)
- Generates **interview-ready answers** using Gemini Flash
- Works offline except for Groq + Gemini API calls
- Fully free (uses your own API keys)

---

## 📂 Project Structure

```
InterviewAI/
│
├── backend/
│   ├── api_server.py        # FastAPI backend (session init, LLM streaming, STT broadcasting)
│   ├── stt_engine.py        # System-audio STT engine pushing text to backend
│   ├── llm_pipeline.py      # Gemini Flash LLM logic + session memory
│   ├── test_stt.py          # STT-only tester
│   ├── ws_test.py           # WebSocket tester for LLM answers
│   └── .env                 # API keys (NOT COMMITTED)
│
├── frontend/
│   ├── index.html           # Test UI for streaming STT + LLM
│   └── (later: Electron app)
│
├── .venv/                   # Python virtual environment
└── README.md
```

---

## 🛠 Requirements

- Python 3.10+
- Windows 10/11
- Groq API Key → https://console.groq.com
- Gemini API Key → https://aistudio.google.com/app/apikey
- Stereo Mix enabled (for system audio capture)

---

## 🔧 Installation

### 1. Clone repo
```bash
git clone https://github.com/<your-username>/InterviewAI.git
cd InterviewAI
```

### 2. Create virtual environment
```bash
python -m venv .venv
```

### 3. Activate it

**Windows PowerShell**
```bash
.venv\Scripts\activate
```

**Git Bash**
```bash
source .venv/Scripts/activate
```

### 4. Install dependencies
```bash
pip install -r backend/requirements.txt
```

If you don’t have a `requirements.txt` yet, generate it:
```bash
pip freeze > backend/requirements.txt
```

---

## 🔑 Environment Variables

Create `backend/.env`:

```
GROQ_API_KEY=your_groq_key_here
GEMINI_API_KEY=your_gemini_key_here
INTERVIEWAI_API_BASE=http://127.0.0.1:8000
```

---

## 🚀 Running the System

### Terminal 1 – Start FastAPI backend
```bash
cd backend
uvicorn api_server:app --reload --port 8000
```

### Terminal 2 – Start STT engine
```bash
cd backend
python stt_engine.py
```

### Terminal 3 – Start UI (test HTML)
Just open:
```
frontend/index.html
```

---

## 🧪 Testing (Optional)

### Test LLM WebSocket
```bash
python backend/ws_test.py
```

### Test STT only
```bash
python backend/test_stt.py
```

---

## 📌 Notes

- STT listens to **system audio**, not microphone.
- Use Stereo Mix (WASAPI) as loopback device.
- Electron overlay UI will be added later.
- All code is modular: backend can run independently of UI.

---

## 📜 License

MIT (or whatever you choose)
