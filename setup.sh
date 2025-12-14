#!/usr/bin/env bash
set -e

# Root directory of the project (directory containing this script)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/app/electron-app"
ENV_FILE="$BACKEND_DIR/.env"

printf "\n=== InterviewAI Setup Script ===\n"
printf "Project root: %s\n" "$ROOT_DIR"

# 1. Create backend/.env with dummy values (if it does not already exist)
printf "\n[1/3] Setting up backend .env...\n"
if [ -f "$ENV_FILE" ]; then
  printf -- "- Skipping: %s already exists.\n" "$ENV_FILE"
else
  cat > "$ENV_FILE" << 'EOF'
# API Keys
GROQ_API_KEY=gsk_your_dummy_groq_key_here
TAVILY_API_KEY=tvly_your_dummy_tavily_key_here

# Configuration
INTERVIEWAI_API_BASE=http://127.0.0.1:8000
WHISPER_LANGUAGE=en
EOF
  printf -- "- Created %s with dummy values.\n" "$ENV_FILE"
fi

# 2. Backend setup: Python venv + dependencies
printf "\n[2/3] Setting up Python backend...\n"
if [ ! -d "$BACKEND_DIR" ]; then
  printf "Error: backend directory not found at %s\n" "$BACKEND_DIR" >&2
  exit 1
fi

cd "$BACKEND_DIR"

# Create virtual environment if missing
if [ ! -d ".venv" ]; then
  printf -- "- Creating Python virtual environment in backend/.venv...\n"
  python -m venv .venv
else
  printf -- "- Virtual environment already exists at backend/.venv (skipping creation).\n"
fi

# Activate venv (supports Git Bash / WSL / generic bash on Windows)
# shellcheck source=/dev/null
if [ -f ".venv/Scripts/activate" ]; then
  # Windows (Git Bash / MSYS)
  . .venv/Scripts/activate
elif [ -f ".venv/bin/activate" ]; then
  # POSIX-style
  . .venv/bin/activate
else
  printf "Error: could not find activate script in .venv.\n" >&2
  exit 1
fi

# Install backend dependencies (prefer requirements.txt if present)
if [ -f "requirements.txt" ]; then
  printf -- "- Installing backend dependencies from requirements.txt...\n"
  pip install --upgrade pip
  pip install -r requirements.txt
else
  printf -- "- requirements.txt not found, installing core packages directly...\n"
  pip install fastapi uvicorn[standard] groq tavily-python sounddevice numpy scipy python-dotenv requests websockets
fi

printf -- "- Backend setup complete.\n"

# Deactivate venv to avoid side effects for rest of script
if command -v deactivate >/dev/null 2>&1; then
  deactivate || true
fi

# 3. Frontend setup: npm install for Electron app
printf "\n[3/3] Setting up Electron frontend...\n"
if [ ! -d "$FRONTEND_DIR" ]; then
  printf "Error: Electron app directory not found at %s\n" "$FRONTEND_DIR" >&2
  exit 1
fi

cd "$FRONTEND_DIR"

if [ -f "package.json" ]; then
  printf -- "- Running npm install in app/electron-app...\n"
  npm install
  printf -- "- Frontend setup complete.\n"
else
  printf "Warning: package.json not found in %s, skipping npm install.\n" "$FRONTEND_DIR"
fi

printf "\n=== Setup complete ===\n"
printf "Next steps:\n"
printf "- Start backend API:  cd backend && .venv/Scripts/activate && uvicorn api_server:app --reload --port 8000\n"
printf "- Start STT engine:  cd backend && .venv/Scripts/activate && python stt_engine.py\n"
printf "- Start Electron UI: cd app/electron-app && npm start\n"