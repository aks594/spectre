import sounddevice as sd
import numpy as np
import wave
import io
import time
from groq import Groq
import dotenv, os
from scipy.signal import resample  # resampling

# Load API key
dotenv.load_dotenv()
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# DEVICE CONFIG
DEVICE_INDEX = 16                  # Stereo Mix (Realtek)
DEVICE_SR = 48000                  # device sample rate (from query)
TARGET_SR = 16000                  # Whisper requirement

# ROLLING BUFFER CONFIG
WINDOW = 3.5                       # seconds
SHIFT = WINDOW / 2                 # overlap
MIN_RMS = 0.01                     # silence threshold

CHANNELS = 1

print(f"🎤 Using loopback: {DEVICE_INDEX} @ {DEVICE_SR} Hz")
print("Starting resampled rolling-buffer STT...\n")

# ---------- WAV CONVERSION ----------
def to_wav_bytes(float_chunk, sr):
    pcm16 = (float_chunk * 32767).astype(np.int16)
    buffer = io.BytesIO()
    wf = wave.open(buffer, "wb")
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(sr)
    wf.writeframes(pcm16.tobytes())
    wf.close()
    buffer.seek(0)
    return buffer.read()

# ---------- GROQ WHISPER ----------
def transcribe_groq(wav_bytes):
    try:
        resp = client.audio.transcriptions.create(
            file=("audio.wav", wav_bytes, "audio/wav"),
            model="whisper-large-v3",
            language="en",
            response_format="text"
        )
        return resp.strip()
    except Exception as e:
        print("[Groq Error]", e)
        return ""

# ---------- ROLLING BUFFER ----------
rolling_buffer = np.zeros(int(DEVICE_SR * WINDOW), dtype=np.float32)
shift_samples = int(DEVICE_SR * SHIFT)

# ---------- CALLBACK ----------
def audio_callback(indata, frames, time_info, status):
    global rolling_buffer

    if status:
        print("[Status]", status)

    audio = indata[:, 0]  # first channel
    # Append to rolling buffer
    rolling_buffer = np.concatenate([rolling_buffer, audio])
    rolling_buffer = rolling_buffer[-int(DEVICE_SR * WINDOW):]

    # Skip silence
    rms = np.sqrt(np.mean(rolling_buffer**2))
    if rms < MIN_RMS:
        return

    # RESAMPLE → 16 kHz
    resampled = resample(rolling_buffer, int(TARGET_SR * WINDOW))

    # to WAV
    wav_bytes = to_wav_bytes(resampled, TARGET_SR)

    # TRANSCRIBE
    text = transcribe_groq(wav_bytes)
    if text:
        print("🔊", text)

# ---------- MAIN LOOP ----------
try:
    with sd.InputStream(
        device=DEVICE_INDEX,
        channels=CHANNELS,
        samplerate=DEVICE_SR,
        dtype="float32",
        callback=audio_callback,
        blocksize=shift_samples
    ):
        while True:
            time.sleep(0.1)

except KeyboardInterrupt:
    print("\nStopped.")
