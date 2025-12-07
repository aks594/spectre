import os
import json
import re
from dataclasses import dataclass, field
from typing import List, Dict, Generator, Optional

from groq import Groq
from tavily import TavilyClient
from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY not set in .env")

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")
if not TAVILY_API_KEY:
    raise RuntimeError("TAVILY_API_KEY not set in .env")

groq_client = Groq(api_key=GROQ_API_KEY)
tavily_client = TavilyClient(api_key=TAVILY_API_KEY)

MODEL_NAME = "llama-3.3-70b-versatile"

tools = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for up-to-date technical information.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to find relevant information."
                    }
                },
                "required": ["query"]
            }
        }
    }
]


# ---------- TOOL PARSING HELPERS ----------

def extract_web_search_query(text: str) -> Optional[str]:
    """Extract a web_search query from malformed tool markup in text."""
    patterns = [
        r"<function=web_search[^\n]*\{[^}]*\"query\"\s*:\s*\"([^\"]+)\"[^}]*\}[^<]*</function>",
        r"<function=web_search[^\n]*\{[^}]*\"query\"\s*:\s*\"([^\"]+)\"[^}]*\}[^>]*/?>",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE | re.DOTALL)
        if m:
            return m.group(1)
    return None


# ---------- SESSION STATE ----------

@dataclass
class QAPair:
    question: str
    answer: str


@dataclass
class SessionState:
    company: str
    role: str
    jd_summary: str
    resume_summary: str
    extra_instructions: str = ""
    memory: List[QAPair] = field(default_factory=list)

    def add_memory(self, question: str, answer: str, max_pairs: int = 5) -> None:
        self.memory.append(QAPair(question=question, answer=answer))
        if len(self.memory) > max_pairs:
            self.memory = self.memory[-max_pairs:]


# ---------- HELPER: SUMMARIZATION ----------

def _summarize_text(raw_text: str, purpose: str) -> str:
    """Generic summarizer for JD / resume."""
    if not raw_text.strip():
        return ""

    prompt = f"""
You are helping prepare for a job interview.

Purpose: {purpose}

Input text:
\"\"\"{raw_text[:8000]}\"\"\"

Task:
- Summarize the key points in 5-8 bullet points.
- Focus only on information that is relevant for interview answers.
- Output plain text bullets, no extra commentary.
"""
    resp = groq_client.chat.completions.create(
        model=MODEL_NAME,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
        max_tokens=300,
    )
    return resp.choices[0].message.content


def summarize_resume(raw_resume: str) -> str:
    return _summarize_text(raw_resume, "Summarize this resume for tailoring interview answers.")


def summarize_jd(raw_jd: str) -> str:
    return _summarize_text(raw_jd, "Summarize this job description for tailoring interview answers.")


# ---------- PROMPT BUILDING ----------

SYSTEM_PROMPT = """
You are my private interview answer generator.

Your only job is to produce short, direct, ready-to-speak answers to interview questions.

Rules:
- Answer in 3–6 sentences unless the question clearly needs less.
- Never explain your reasoning.
- Never talk about what you are doing.
- Never say things like "here is your answer" or "as an AI".
- Use simple, natural spoken English.
- Tone: confident, clear, concise.
- Prefer examples and specifics over generic buzzwords.
- Align every answer with my resume, skills, and the job description.
- If relevant, briefly mention my experience or projects that make sense for the question.
- If the question is behavioral, use STAR-style implicitly but do NOT say "STAR".
- If the question is vague, assume the most common interview interpretation.
- If you need up-to-date technical information or current documentation, use the web_search tool.
"""


def build_prompt(session: SessionState, question: str) -> str:
    # Conversation memory
    memory_block = ""
    if session.memory:
        parts = []
        for qa in session.memory:
            parts.append(f"Q: {qa.question}\nA: {qa.answer}")
        memory_block = "Conversation Memory (previous questions and answers):\n" + "\n\n".join(parts)

    session_context = f"""
Session Context:
- Company: {session.company}
- Role: {session.role}

Job Description Summary:
{session.jd_summary}

My Resume Summary:
{session.resume_summary}

Extra Instructions from me:
{session.extra_instructions or "None"}
"""

    final_prompt = f"""{SYSTEM_PROMPT}

{session_context}

{memory_block}

New Interviewer Question:
"{question}"

Your answer (only the answer text, no meta, no explanation):
"""
    return final_prompt


# ---------- LLM ANSWER: STREAMING ----------

def stream_answer(session: SessionState, question: str) -> Generator[str, None, str]:
    """Stream answer tokens for a given question with tool-calling support."""
    prompt = build_prompt(session, question)
    base_user_msg = {"role": "user", "content": prompt}
    messages = [base_user_msg]

    # Step 1: Initial call to check for tool calls
    try:
        response = groq_client.chat.completions.create(
            model=MODEL_NAME,
            messages=messages,
            tools=tools,
            tool_choice="auto",
            temperature=0.3,
            max_tokens=220,
        )
        assistant_message = response.choices[0].message
        tool_calls = assistant_message.tool_calls or []
        content = assistant_message.content or ""
    except Exception as e:
        error_str = str(e)
        query = extract_web_search_query(error_str)
        if query:
            print(f"🕵️ Searching (error path): {query}...")
            search_results = tavily_client.search(query, search_depth="basic")
            tool_content = json.dumps(search_results)

            messages = [
                base_user_msg,
                {"role": "assistant", "content": error_str},
                {"role": "tool", "tool_call_id": "error_parsed", "content": tool_content},
            ]

            stream = groq_client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages,
                temperature=0.3,
                max_tokens=220,
                stream=True,
            )

            full_answer = ""
            for chunk in stream:
                if chunk.choices[0].delta.content:
                    full_answer += chunk.choices[0].delta.content
                    yield chunk.choices[0].delta.content

            full_answer = full_answer.strip()
            session.add_memory(question, full_answer)
            return full_answer
        raise

    # Branch: proper tool calls
    if tool_calls:
        tool_call = tool_calls[0]
        args = json.loads(tool_call.function.arguments)
        query = args.get("query", "")
        print(f"🕵️ Searching: {query}...")
        search_results = tavily_client.search(query, search_depth="basic")
        tool_content = json.dumps(search_results)

        messages = [
            base_user_msg,
            {"role": "assistant", "content": content, "tool_calls": tool_calls},
            {"role": "tool", "tool_call_id": tool_call.id, "content": tool_content},
        ]

        stream = groq_client.chat.completions.create(
            model=MODEL_NAME,
            messages=messages,
            temperature=0.3,
            max_tokens=220,
            stream=True,
        )

        full_answer = ""
        for chunk in stream:
            if chunk.choices[0].delta.content:
                full_answer += chunk.choices[0].delta.content
                yield chunk.choices[0].delta.content

        full_answer = full_answer.strip()
        session.add_memory(question, full_answer)
        return full_answer

    # Branch: malformed tool call embedded in content
    query = extract_web_search_query(content)
    if query:
        print(f"🕵️ Searching (content path): {query}...")
        search_results = tavily_client.search(query, search_depth="basic")
        tool_content = json.dumps(search_results)

        messages = [
            base_user_msg,
            {"role": "assistant", "content": content},
            {"role": "tool", "tool_call_id": "content_parsed", "content": tool_content},
        ]

        stream = groq_client.chat.completions.create(
            model=MODEL_NAME,
            messages=messages,
            temperature=0.3,
            max_tokens=220,
            stream=True,
        )

        full_answer = ""
        for chunk in stream:
            if chunk.choices[0].delta.content:
                full_answer += chunk.choices[0].delta.content
                yield chunk.choices[0].delta.content

        full_answer = full_answer.strip()
        session.add_memory(question, full_answer)
        return full_answer

    # Branch: no tools, stream normally
    stream = groq_client.chat.completions.create(
        model=MODEL_NAME,
        messages=messages,
        temperature=0.3,
        max_tokens=220,
        stream=True,
    )

    full_answer = ""
    for chunk in stream:
        if chunk.choices[0].delta.content:
            full_answer += chunk.choices[0].delta.content
            yield chunk.choices[0].delta.content

    full_answer = full_answer.strip()
    session.add_memory(question, full_answer)
    return full_answer


# ---------- SIMPLE CLI TEST ----------

if __name__ == "__main__":
    # Example: quick test without STT
    raw_resume = """Experienced Software Engineer with a strong background in backend development and mobile app development using Flutter. Proficient in Dart, Python, and Java, with hands-on experience in building scalable web services and cross-platform mobile applications. Skilled in RESTful API design, database management, and cloud technologies. Adept at problem-solving and delivering high-quality code in agile environments. Passionate about learning new technologies and improving software performance."""

    raw_jd = """We are seeking a Software Engineer to join our dynamic team at Example Corp. The ideal candidate will have experience in backend development and mobile app development using Flutter. Responsibilities include designing and implementing scalable web services, collaborating with cross-functional teams, and contributing to the full software development lifecycle. Proficiency in Dart, Python, and Java is required, along with a strong understanding of RESTful API design and cloud technologies. The candidate should be able to work in an agile environment and have excellent problem-solving skills."""

    resume_summary = summarize_resume(raw_resume) if raw_resume.strip() else "No resume summary."
    jd_summary = summarize_jd(raw_jd) if raw_jd.strip() else "No JD summary."

    session = SessionState(
        company="Example Corp",
        role="Software Engineer",
        jd_summary=jd_summary,
        resume_summary=resume_summary,
        extra_instructions="Prefer answers from the perspective of a backend + Flutter dev.",
    )

    question = "Tell me about yourself."
    print(f"\nQ: {question}\nA: ", end="", flush=True)

    # stream and print
    answer_collected = ""
    for chunk in stream_answer(session, question):
        print(chunk, end="", flush=True)
        answer_collected += chunk

    print("\n\n--- Full answer ---")
    print(answer_collected)
