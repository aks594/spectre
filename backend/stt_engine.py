import os
import time
import io
import wave
import difflib
import requests
import numpy as np
import sounddevice as sd
import queue
import threading
from dotenv import load_dotenv
from groq import Groq

sd.default.latency = 'low'

# ---------- SIMPLE AUDIO FILTERS ----------
def highpass_filter(samples: np.ndarray, cutoff_hz: float, sr: int) -> np.ndarray:
    """
    Very cheap 1-pole high-pass filter to remove low rumble (AC, fans).
    """
    # normalized RC
    from math import pi
    rc = 1.0 / (2 * pi * cutoff_hz)
    dt = 1.0 / sr
    alpha = rc / (rc + dt)

    if len(samples) == 0:
        return samples

    y = np.empty_like(samples)
    y[0] = samples[0]
    for i in range(1, len(samples)):
        y[i] = alpha * (y[i - 1] + samples[i] - samples[i - 1])
    return y


# ---------- ENV & API KEYS ----------
load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY missing in .env")

groq_client = Groq(api_key=GROQ_API_KEY)

API_BASE = os.getenv("INTERVIEWAI_API_BASE", "http://127.0.0.1:8000")
# WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "")  # empty -> auto-detect (better for Hinglish)
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "en")


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
WINDOW = 4.5  # slightly longer window to reduce mid-sentence splits
SHIFT = WINDOW * 0.55
MIN_RMS = 0.015  # slightly stricter noise gate
CHANNELS = 1

MIN_WORDS = 2  # require some content to reduce noise snippets
MIN_CHARS = 10

# rolling_buffer = np.zeros(int(DEVICE_SR * WINDOW), dtype=np.float32)
# shift_samples = max(1, int(DEVICE_SR * SHIFT))
audio_queue = queue.Queue(maxsize=5)  # small buffer to avoid huge lag


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


# def transcribe_chunk_16k(chunk_16k: np.ndarray) -> str:
#     wav_bytes = float_to_wav_bytes(chunk_16k, TARGET_SR)
#     try:
#         resp = groq_client.audio.transcriptions.create(
#             file=("audio.wav", wav_bytes, "audio/wav"),
#             model="whisper-large-v3-turbo",
#             response_format="text",
#             language=WHISPER_LANGUAGE or 'en',
#         )
#         return resp.strip()
#     except Exception as e:
#         print("[STT Error]", e)
#         return ""

def transcribe_chunk_16k(chunk_16k: np.ndarray, last_text: str = "") -> str:
    wav_bytes = float_to_wav_bytes(chunk_16k, TARGET_SR)
    try:
        # Take the last 200 chars as context to keep the prompt efficient
        prompt_text = last_text[-200:] if last_text else "This is a technical interview."
        
        resp = groq_client.audio.transcriptions.create(
            file=("audio.wav", wav_bytes, "audio/wav"),
            model="whisper-large-v3-turbo",
            response_format="text",
            language=WHISPER_LANGUAGE or 'en',
            prompt=prompt_text  # <--- CRITICAL ADDITION
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
last_transcription_time = 0.0  # seconds
COOLDOWN_SECONDS = 2.0         # minimum gap between accepted transcriptions

# Global accumulation buffer
accumulated_audio = np.array([], dtype=np.float32)
silence_start_time = None
IS_SPEAKING = False

# Config for VAD
SILENCE_THRESHOLD = 0.6  # Seconds of silence to trigger a send
VAD_RMS_THRESHOLD = 0.015  # Adjust based on mic sensitivity

def audio_callback(indata, frames, time_info, status):
    global accumulated_audio, silence_start_time, IS_SPEAKING

    if status:
        print("[AUDIO STATUS]", status)

    # 1. Get Audio & Filter
    audio = indata[:, 0]
    audio = highpass_filter(audio, cutoff_hz=100.0, sr=DEVICE_SR)

    # 2. Calculate Energy (RMS)
    rms = np.sqrt(np.mean(audio**2))

    # 3. VAD Logic
    if rms > VAD_RMS_THRESHOLD:
        # Speech detected
        IS_SPEAKING = True
        silence_start_time = None  # Reset silence timer
    elif IS_SPEAKING:
        # We were speaking, but now it's quiet. Start timing the silence.
        if silence_start_time is None:
            silence_start_time = time.time()
    
    # 4. Accumulate audio
    # Only accumulate if we are currently speaking or just finished
    if IS_SPEAKING:
        accumulated_audio = np.concatenate([accumulated_audio, audio])

    # 5. Trigger Logic (Silence Duration Reached)
    if IS_SPEAKING and silence_start_time and (time.time() - silence_start_time > SILENCE_THRESHOLD):
        # User finished a sentence!
        
        # Resample immediately (using the fast slice method)
        if DEVICE_SR == 48000:
             # Fast decimation for 48k -> 16k
            chunk_to_send = accumulated_audio[::3].astype(np.float32)
        else:
            chunk_to_send = fast_resample(accumulated_audio, DEVICE_SR, TARGET_SR, len(accumulated_audio)/DEVICE_SR)

        # Send to worker
        try:
            audio_queue.put_nowait(chunk_to_send)
        except queue.Full:
            pass # Drop if busy
        
        # RESET
        accumulated_audio = np.array([], dtype=np.float32)
        IS_SPEAKING = False
        silence_start_time = None


def worker_loop():
    global last_transcription, last_transcription_time

    while True:
        chunk = audio_queue.get()  # blocks until audio available

        # Inside worker_loop:
        text = transcribe_chunk_16k(chunk, last_transcription)
        if not text:
            continue

        # Content gating to drop very short/noisy fragments
        words = text.strip().split()
        if len(words) < MIN_WORDS and len(text.strip()) < MIN_CHARS:
            continue

        # Skip near-duplicates to reduce backend noise
        text_normalized = text.strip().lower()
        similarity = difflib.SequenceMatcher(
            None, text_normalized, last_transcription
        ).ratio()
        if similarity > 0.9 and len(text_normalized) <= len(last_transcription) + 4:
            continue

        last_transcription = text_normalized
        last_transcription_time = time.time()
        print(f"\n[STT {time.strftime('%Y-%m-%d %H:%M:%S')}] {text}")
        push_to_backend(text)


# ---------- MAIN ----------
def main():
    # start worker
    t = threading.Thread(target=worker_loop, daemon=True)
    t.start()
    
    # CRITICAL FIX: Make blocksize small (e.g., 0.2 seconds) 
    # so VAD can detect silence quickly.
    # 48000 Hz * 0.2s = 9600 samples
    vad_block_size = int(DEVICE_SR * 0.2) 

    try:
        with sd.InputStream(
            samplerate=DEVICE_SR,
            device=DEVICE_INDEX,
            channels=CHANNELS,
            dtype="float32",
            blocksize=vad_block_size, # <--- CHANGED FROM shift_samples
            callback=audio_callback,
        ):
            print(f"✔ STT engine running (VAD Mode). Device: {DEVICE_INDEX}, Blocksize: {vad_block_size}")
            print("✔ Press Ctrl+C to stop.\n")
            while True:
                time.sleep(0.1)
    except KeyboardInterrupt:
        print("\nSTT engine stopped.")


if __name__ == "__main__":
    main()
