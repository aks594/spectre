# Spectre – Stealth Real-Time Interview Copilot

**Spectre** is a local, privacy-focused desktop application designed to assist developers during live technical interviews. It captures system audio in real-time, transcribes it, and uses an Agentic AI pipeline (Llama 3 via Groq + Tavily Search) to generate context-aware, technically accurate answers.

The application features a **Stealth HUD** and **Brain Overlay** that are invisible to screen capture tools (Zoom, Google Meet, Teams, OBS) using native Windows APIs.

---

## ⚡ Quickstart

For the fastest path from clone to running app:

1. In a Bash-capable terminal (Git Bash, WSL, etc.), from the project root:
   ```bash
   bash setup.sh
   ```
   This provisions the backend virtual environment, installs Python + Node dependencies, and creates a dummy `backend/.env`.
2. Start the three services (one terminal each):
   - Backend API:
     ```bash
     cd backend
     .venv/Scripts/activate  # or source .venv/Scripts/activate on WSL
     uvicorn api_server:app --reload --port 8000
     ```
   - STT engine:
     ```bash
     cd backend
     .venv/Scripts/activate  # or source .venv/Scripts/activate on WSL
     python stt_engine.py
     ```
   - Electron UI:
     ```bash
     cd app/electron-app
     npm start
     ```

You can also follow the detailed manual steps below; the commands above are the minimum to get everything running.

---

## ⚠️ System Requirements

* **Operating System:** Windows 10 or Windows 11 (Required for WASAPI audio loopback and `user32.dll` stealth hooks).
* **Audio:** "Stereo Mix" must be enabled (or a valid system loopback device).
* **Runtime:** Node.js (v16+) and Python (v3.10+).

---

## 🔑 1. Environment Setup & API Keys

Before installing the code, you need to generate API keys for the AI engines and configure the backend environment.

### A. Get API Keys
1. **Groq API Key** (for LLM & STT):
  * Sign up at [Groq Console](https://console.groq.com/keys).
  * Create a new API Key.
2. **Tavily API Key** (for real-time web search):
  * Sign up at [Tavily](https://tavily.com/).
  * Create a new API Key.

### B. Configure Environment Variables

You can either let the setup script create a dummy `.env` for you, or create it manually.

**Option 1 (Recommended) – Auto-generate via setup.sh**

1. From the project root, run (in Git Bash, WSL, or any Bash shell):
  ```bash
  bash setup.sh
  ```
2. This will create `backend/.env` with dummy values. Open that file and replace the placeholders with your real keys.

**Option 2 – Manual .env creation**

1. Navigate to the `backend/` folder.
2. Create a file named `.env`.
3. Paste the following content and replace the placeholders with your actual keys:

```ini
# backend/.env

# API Keys
GROQ_API_KEY=gsk_your_actual_groq_key_here
TAVILY_API_KEY=tvly_your_actual_tavily_key_here

# Configuration
INTERVIEWAI_API_BASE=http://127.0.0.1:8000
WHISPER_LANGUAGE=en
```

-----

## 🔊 2. Enable System Audio Capture (Crucial)

To let the AI "hear" the interviewer via your speakers/headphones, you must enable **Stereo Mix** on Windows.

1.  Press `Win + R`, type `mmsys.cpl`, and hit Enter.
2.  Go to the **Recording** tab.
3.  Right-click in the empty space and check **"Show Disabled Devices"**.
4.  Find **Stereo Mix** (Realtek/High Definition Audio).
5.  Right-click it and select **Enable**.
6.  Right-click it again -\> **Properties** -\> **Levels** -\> Set to **100**.

> **Note:** If you do not have Stereo Mix, the app allows for fallback to specific output devices, but enabling Stereo Mix is the most reliable method.

-----

## 📦 3. Installation Instructions

You can use the automated setup script (recommended) or follow the manual steps.

### Option A (Recommended): Automated Setup via setup.sh

1. Open a Bash-capable terminal in the project root (Git Bash, WSL, etc.).
2. Run:
  ```bash
  bash setup.sh
  ```
3. What this does:
   - Creates `backend/.env` with dummy values (if it does not exist).
   - Creates `backend/.venv` and installs Python dependencies (from `backend/requirements.txt` if present).
   - Runs `npm install` in `app/electron-app` to install Electron dependencies.
4. After it finishes, edit `backend/.env` to plug in your real API keys.

### Option B: Manual Backend Setup (Python)

1. Open a terminal in the root project folder.
2. Navigate to the backend:
  ```bash
  cd backend
  ```
3. Create a virtual environment:
  ```bash
  python -m venv .venv
  ```
4. Activate the virtual environment:
  - **PowerShell:**
    ```powershell
    .venv\Scripts\activate
    ```
  - **Git Bash / WSL:**
    ```bash
    source .venv/Scripts/activate
    ```
5. Install dependencies (or just use `pip install -r requirements.txt` if you prefer):
   ```bash
   pip install fastapi uvicorn[standard] groq tavily-python sounddevice numpy scipy python-dotenv requests websockets
   ```

### Option C: Manual Frontend Setup (Electron)

1. Open a **new** terminal.
2. Navigate to the electron app folder:
  ```bash
  cd app/electron-app
  ```
3. Install Node.js dependencies (including `koffi` for native Windows hooks):
  ```bash
  npm install
  ```
4. Install Electron Forge CLI globally (optional but recommended):
  ```bash
  npm install -g @electron-forge/cli
  ```

-----

## 🚀 4. Running the Application

After you have completed installation (preferably via `setup.sh`), you run the system by starting three separate processes in parallel. Open 3 terminal windows.

### Terminal 1: Backend API Server

This handles the session state, LLM processing, and WebSocket broadcasting.

```bash
cd backend
# Ensure venv is activated (.venv\Scripts\activate)
uvicorn api_server:app --reload --port 8000
```

*Wait until you see: `Uvicorn running on http://127.0.0.1:8000`*

### Terminal 2: STT Engine ( The "Ears" )

This listens to your system audio and pushes text to the backend.

```bash
cd backend
# Ensure venv is activated (.venv\Scripts\activate)
python stt_engine.py
```

*Wait until you see: `✔ Found 'Stereo Mix' at Index X...`*

### Terminal 3: Frontend UI ( The "Face" )

This launches the invisible desktop overlay.

```bash
cd app/electron-app
npm start
```

-----

## 🎮 Usage Guide

1.  **Initialization:**
      * When the app launches, it automatically tries to initialize a session.
      * The **HUD** (small pill at the top) shows the live transcript.
2.  **During the Interview:**
      * **Start/Stop Listening:** Use the toggle in the HUD to pause audio capture.
      * **Get an Answer:** Click **"AI Answer"** on the HUD.
      * The **Brain Overlay** will appear.
      * It streams the **Summarized Question** first, followed by the **Answer**.
3.  **Stealth Mode:**
      * The application uses `SetWindowDisplayAffinity` with the `WDA_EXCLUDEFROMCAPTURE` flag.
      * **Result:** You can share your entire screen in Zoom/Meet/Teams. The interviewer **will not see** the HUD or the Brain overlay, but **you will**.
      * *Warning:* Do not rely on this blindly. Test it with a friend first.

-----

## 🛠 Troubleshooting

**1. "Stereo Mix not found" in Terminal 2:**

  * Ensure you enabled it in Windows Sound Settings (Section 2).
  * Restart your computer if you just enabled it.

**2. Transcript is empty / AI not hearing anything:**

  * Ensure the volume on your computer is up.
  * Ensure `python stt_engine.py` is running and printing logs in the terminal.
  * Check if the **"Stop Listening"** button in the HUD is active (Red).

**3. "No session initialized" Error:**

  * The app auto-initializes on start. If this fails, restart the **Backend Server** (Terminal 1) and then the **Electron App** (Terminal 3).

**4. Windows C++ Build Tools Error (during `npm install`):**

  * The package `koffi` or `electron-rebuild` might require build tools.
  * Install Visual Studio Build Tools with "Desktop development with C++".

-----

## 📂 Project Structure

```
Spectre/
├── backend/                  # Python Logic
│   ├── api_server.py         # FastAPI WebSocket Server
│   ├── stt_engine.py         # Audio Capture & Whisper STT
│   ├── llm_pipeline.py       # Llama 3 Agent + Tavily Logic
│   └── services/             # Helper services
│
├── app/electron-app/         # Frontend Logic
│   ├── src/
│   │   ├── main/             # Electron Main Process (Window Mgmt, Stealth)
│   │   ├── renderer/         # UI Logic (DOM, WebSockets)
│   │   └── preload/          # IPC Bridge
│   └── public/               # HTML/CSS assets (HUD, Brain)
│
└── requirements.txt          # (Auto-generated by you if needed)
```

## 📜 License

This project is for educational and personal use only.
