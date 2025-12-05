import time
import numpy as np
import sounddevice as sd
from scipy.signal import resample

from llm_pipeline import (
    SessionState,
    stream_answer,
    summarize_resume,
    summarize_jd
)

import os
from dotenv import load_dotenv
from groq import Groq

# ---------------------- ENV + API ----------------------
load_dotenv()
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY missing in .env")

groq_client = Groq(api_key=GROQ_API_KEY)

# ---------------------- AUDIO CONFIG -------------------
DEVICE_INDEX = 16       # Your Stereo Mix WASAPI device
DEVICE_SR = 48000       # Found earlier from sd.query_devices
TARGET_SR = 16000       # Whisper requirement

WINDOW = 3.5            # seconds
SHIFT = WINDOW / 2      # overlap
MIN_RMS = 0.01          # silence threshold
CHANNELS = 1

rolling_buffer = np.zeros(int(DEVICE_SR * WINDOW), dtype=np.float32)
shift_samples = int(DEVICE_SR * SHIFT)

print(f"🎤 Using loopback device index {DEVICE_INDEX} @ {DEVICE_SR} Hz")
print("Starting interview runtime (manual trigger mode)...\n")


# -------------------- WAV Conversion --------------------
import io, wave
def float_to_wav_bytes(chunk_float32, sr):
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


# -------------------- GROQ STT CALL --------------------
def transcribe_audio_chunk(chunk_16k):
    """
    chunk_16k: numpy float32 audio, already resampled to 16k.
    """
    wav_bytes = float_to_wav_bytes(chunk_16k, TARGET_SR)

    try:
        resp = groq_client.audio.transcriptions.create(
            file=("audio.wav", wav_bytes, "audio/wav"),
            model="whisper-large-v3",
            response_format="text",
            language="en"
        )
        return resp.strip()
    except Exception as e:
        print("[STT Error]", e)
        return ""


# -------------------- GLOBAL STATE ----------------------
last_transcript = ""  # holds the last STT chunk for manual sending


# -------------------- AUDIO CALLBACK --------------------
def audio_callback(indata, frames, time_info, status):
    global rolling_buffer, last_transcript

    if status:
        print("[AUDIO STATUS]", status)

    audio = indata[:, 0]

    # Rolling buffer update
    rolling_buffer[:] = np.concatenate([rolling_buffer, audio])[-len(rolling_buffer):]

    # Check silence
    if np.sqrt(np.mean(rolling_buffer**2)) < MIN_RMS:
        return

    # Resample buffer → 16k
    resampled = resample(rolling_buffer, int(TARGET_SR * WINDOW))

    # Transcribe using Groq
    text = transcribe_audio_chunk(resampled)
    if text:
        last_transcript = text
        print(f"\n🎙️ INTERVIEWER: {text}\n")
        print("⏳ Press ENTER to send this to LLM...", flush=True)


# -------------------- MAIN PIPELINE ---------------------
def main():
    global last_transcript

    print("=== INTERVIEW SESSION STARTED ===")
    print("Mode: Manual trigger (press ENTER to get LLM answer)\n")

    # Gather session info once
    resume_text = input("Paste resume text (or leave empty): ").strip()
    jd_text = input("\nPaste JD text (or leave empty): ").strip()
    company = input("\nCompany: ").strip() or "Unknown Company"
    role = input("Role: ").strip() or "Candidate"
    extra = input("Extra instructions (optional): ").strip()

    print("\nSummarizing resume & JD (Gemini)...")
    resume_summary = summarize_resume(resume_text) if resume_text else ""
    jd_summary = summarize_jd(jd_text) if jd_text else ""

    session = SessionState(
        company=company,
        role=role,
        jd_summary=jd_summary,
        resume_summary=resume_summary,
        extra_instructions=extra,
    )

    print("\n✔ Setup done. Listening for audio...")
    print("✔ Whenever you want an answer, PRESS ENTER.\n")

    try:
        with sd.InputStream(
            samplerate=DEVICE_SR,
            device=DEVICE_INDEX,
            channels=CHANNELS,
            dtype="float32",
            blocksize=shift_samples,
            callback=audio_callback,
        ):
            while True:
                _ = input()  # wait for ENTER
                question = last_transcript.strip()

                if not question:
                    print("⚠ No transcript available yet.")
                    continue

                print("\n🤖 ASSISTANT (streaming): ", end="", flush=True)

                full = ""
                for chunk in stream_answer(session, question):
                    print(chunk, end="", flush=True)
                    full += chunk

                print("\n\n✔ FULL ANSWER SAVED TO MEMORY.\n")

    except KeyboardInterrupt:
        print("\nSession ended.")


if __name__ == "__main__":
    main()
