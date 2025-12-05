import os
import time
import io
import wave
import requests

import numpy as np
import sounddevice as sd
from scipy.signal import resample
from dotenv import load_dotenv
from groq import Groq

# ---------- ENV & API KEYS ----------
load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY missing in .env")

groq_client = Groq(api_key=GROQ_API_KEY)

API_BASE = os.getenv("INTERVIEWAI_API_BASE", "http://127.0.0.1:8000")


# ---------- AUDIO CONFIG ----------
DEVICE_INDEX = 16          # Stereo Mix (Realtek), WASAPI (from your query_devices)
DEVICE_SR = 48000          # native sample rate for that device
TARGET_SR = 16000          # Whisper expects 16k

WINDOW = 3.5               # seconds of rolling window
SHIFT = WINDOW / 2         # half-overlap
MIN_RMS = 0.01             # silence threshold
CHANNELS = 1

rolling_buffer = np.zeros(int(DEVICE_SR * WINDOW), dtype=np.float32)
shift_samples = int(DEVICE_SR * SHIFT)

print(f"🎤 STT engine using device {DEVICE_INDEX} @ {DEVICE_SR} Hz")
print(f"Backend API base: {API_BASE}")
print("Starting STT engine...\n")


# ---------- HELPERS ----------
def float_to_wav_bytes(chunk_float32: np.ndarray, sr: int) -> bytes:
    pcm16 = (chunk_float32 * 32767).astype(np.int16)
    buff = io.BytesIO()
    wf = wave.open(buff, "wb")
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(sr)
    wf.writeframes(pcm16.tobytes())
    wf.close()
    buff.seek(0)
    return buff.read()


def transcribe_chunk_16k(chunk_16k: np.ndarray) -> str:
    wav_bytes = float_to_wav_bytes(chunk_16k, TARGET_SR)
    try:
        resp = groq_client.audio.transcriptions.create(
            file=("audio.wav", wav_bytes, "audio/wav"),
            model="whisper-large-v3",
            response_format="text",
            language="en",
        )
        return resp.strip()
    except Exception as e:
        print("[STT Error]", e)
        return ""


def push_to_backend(text: str):
    try:
        r = requests.post(f"{API_BASE}/stt/push", json={"text": text}, timeout=2)
        if r.status_code != 200:
            print("[STT PUSH] Non-200 response:", r.status_code, r.text)
    except Exception as e:
        print("[STT PUSH ERROR]", e)


# ---------- AUDIO CALLBACK ----------
def audio_callback(indata, frames, time_info, status):
    global rolling_buffer

    if status:
        print("[AUDIO STATUS]", status)

    # Append audio to rolling buffer
    audio = indata[:, 0]  # first channel
    rolling_buffer = np.concatenate([rolling_buffer, audio])[-len(rolling_buffer):]

    # Silence check
    rms = np.sqrt(np.mean(rolling_buffer**2))
    if rms < MIN_RMS:
        return

    # Resample to 16k
    resampled = resample(rolling_buffer, int(TARGET_SR * WINDOW))

    # Transcribe
    text = transcribe_chunk_16k(resampled)
    if not text:
        return

    print(f"\n[STT] {text}")
    push_to_backend(text)


# ---------- MAIN ----------
def main():
    try:
        with sd.InputStream(
            samplerate=DEVICE_SR,
            device=DEVICE_INDEX,
            channels=CHANNELS,
            dtype="float32",
            blocksize=shift_samples,
            callback=audio_callback,
        ):
            print("✔ STT engine running. Press Ctrl+C to stop.\n")
            while True:
                time.sleep(0.1)
    except KeyboardInterrupt:
        print("\nSTT engine stopped.")


if __name__ == "__main__":
    main()
