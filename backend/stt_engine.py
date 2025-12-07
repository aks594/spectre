import os
import time
import io
import wave
import difflib
import requests

import numpy as np
import sounddevice as sd
from dotenv import load_dotenv
from groq import Groq

# ---------- ENV & API KEYS ----------
load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY missing in .env")

groq_client = Groq(api_key=GROQ_API_KEY)

API_BASE = os.getenv("INTERVIEWAI_API_BASE", "http://127.0.0.1:8000")
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "")  # empty -> auto-detect (better for Hinglish)


# ---------- AUDIO CONFIG (DYNAMIC) ----------
def find_stereo_mix_index():
    devices = sd.query_devices()
    for i, dev in enumerate(devices):
        # Look for "Stereo Mix" and ensure it supports input channels (>0)
        # You can also check for "Windows WASAPI" in dev['hostapi'] if needed
        if "Stereo Mix" in dev['name'] and dev['max_input_channels'] > 0:
            return i, int(dev['default_samplerate'])
    return None, 48000

# Auto-detect index
DEVICE_INDEX, DEVICE_SR = find_stereo_mix_index()

if DEVICE_INDEX is None:
    print("❌ Error: 'Stereo Mix' not found. Please enable it in Windows Sound Settings.")
    # Fallback or exit
    DEVICE_INDEX = 1  # Try a safe default or raise error
else:
    print(f"✔ Found 'Stereo Mix' at Index {DEVICE_INDEX} ({DEVICE_SR} Hz)")

TARGET_SR = 16000
WINDOW = 3.2  # slightly longer window to reduce mid-sentence splits
SHIFT = WINDOW * 0.55
MIN_RMS = 0.015  # slightly stricter noise gate
CHANNELS = 1

MIN_WORDS = 2  # require some content to reduce noise snippets
MIN_CHARS = 10

rolling_buffer = np.zeros(int(DEVICE_SR * WINDOW), dtype=np.float32)
shift_samples = max(1, int(DEVICE_SR * SHIFT))


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


def fast_resample(mono_pcm: np.ndarray, orig_sr: int, target_sr: int, seconds: float) -> np.ndarray:
    """Linear interpolation resample to avoid scipy overhead on short windows."""
    target_len = int(target_sr * seconds)
    if len(mono_pcm) == 0:
        return np.zeros(target_len, dtype=np.float32)
    x_old = np.linspace(0, 1, len(mono_pcm))
    x_new = np.linspace(0, 1, target_len)
    return np.interp(x_new, x_old, mono_pcm).astype(np.float32)


def transcribe_chunk_16k(chunk_16k: np.ndarray) -> str:
    wav_bytes = float_to_wav_bytes(chunk_16k, TARGET_SR)
    try:
        resp = groq_client.audio.transcriptions.create(
            file=("audio.wav", wav_bytes, "audio/wav"),
            model="whisper-large-v3",
            response_format="text",
            language=WHISPER_LANGUAGE or None,
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
# Track last transcription to avoid sending identical consecutive chunks
last_transcription = ""

def audio_callback(indata, frames, time_info, status):
    global rolling_buffer, last_transcription

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
    resampled = fast_resample(rolling_buffer, DEVICE_SR, TARGET_SR, WINDOW)

    # Transcribe
    text = transcribe_chunk_16k(resampled)
    if not text:
        return
    
    # Content gating to drop very short/noisy fragments
    words = text.strip().split()
    if len(words) < MIN_WORDS and len(text.strip()) < MIN_CHARS:
        return

    # Skip near-duplicates to reduce backend noise
    text_normalized = text.strip().lower()
    similarity = difflib.SequenceMatcher(None, text_normalized, last_transcription).ratio()
    if similarity > 0.8:
        # If new text isn't meaningfully longer, treat as duplicate noise
        if len(text_normalized) <= len(last_transcription) + 4:
            return
        return
    
    last_transcription = text_normalized
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
