import os
import json
import re
from dataclasses import dataclass, field
from typing import List, Dict, Generator, Optional, Iterable

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
VISION_MODEL_NAME = "meta-llama/llama-4-scout-17b-16e-instruct"

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

VISION_SECTION_ORDER = ["Intuition", "Algorithm", "Implementation", "Complexity Analysis"]
VISION_HEADING_LOOKUP = {
    "intuition": "Intuition",
    "algorithm": "Algorithm",
    "implementation": "Implementation",
    "complexityanalysis": "Complexity Analysis",
    "complexity": "Complexity Analysis",
}
VISION_SEPARATOR = "---SPLIT---"
DEFAULT_IMPLEMENTATION_LANGUAGE = "Python"

LANGUAGE_ALIASES = {
    "cpp": "C++",
    "cplusplus": "C++",
    "c++": "C++",
    "csharp": "C#",
    "c#": "C#",
    "js": "JavaScript",
    "javascript": "JavaScript",
    "ts": "TypeScript",
    "typescript": "TypeScript",
    "py": "Python",
    "python": "Python",
    "java": "Java",
    "go": "Go",
    "golang": "Go",
    "swift": "Swift",
    "kotlin": "Kotlin",
    "rust": "Rust",
}


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


def _normalize_language_label(label: Optional[str], default: str = DEFAULT_IMPLEMENTATION_LANGUAGE) -> str:
    if not label:
        return default
    cleaned = re.sub(r"[^a-z0-9+#]+", "", label.lower())
    if not cleaned or cleaned in {"unknown", "unsure"}:
        return default
    return LANGUAGE_ALIASES.get(cleaned, label.strip() or default)


def _detect_code_language(image_data_base64: str) -> str:
    detection_prompt = (
        "Identify the primary programming language shown in this screenshot. "
        "Answer with only the language name such as 'C++', 'Java', 'Python'. "
        "If unsure, reply 'Unknown'."
    )
    try:
        resp = groq_client.chat.completions.create(
            model=VISION_MODEL_NAME,
            messages=[
                {
                    "role": "system",
                    "content": "You label the programming language used in code screenshots.",
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": detection_prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{image_data_base64.strip()}"},
                        },
                    ],
                },
            ],
            temperature=0.0,
            max_tokens=16,
        )
        raw_lang = (resp.choices[0].message.content or "").strip()
        return _normalize_language_label(raw_lang)
    except Exception as exc:
        print(f"[Vision] Language detection failed: {exc}")
        return DEFAULT_IMPLEMENTATION_LANGUAGE


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


# ---------- VISION ANSWER SANITIZERS ----------

def _chunk_preserving(text: str, max_len: int = 1200) -> Iterable[str]:
    """Chunk text without stripping newlines so headings/code fences survive."""
    if not text:
        return []

    lines = text.splitlines()
    bucket: list[str] = []
    current = 0

    def flush():
        if not bucket:
            return None
        chunk = "\n".join(bucket).rstrip()
        bucket.clear()
        return chunk

    for line in lines:
        # Always keep code fences and headings intact by flushing before overshoot
        projected = current + len(line) + (1 if bucket else 0)
        if bucket and projected > max_len:
            chunk = flush()
            if chunk:
                yield chunk
            current = 0
        bucket.append(line)
        current += len(line) + 1

    chunk = flush()
    if chunk:
        yield chunk


def _dedupe_sentences(text: str) -> str:
    segments = re.findall(r"[^.?!]+[.?!]?", text) or [text]
    seen = set()
    result = []
    for segment in segments:
        trimmed = segment.strip()
        if not trimmed:
            continue
        fingerprint = trimmed.lower()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        result.append(trimmed)
    return " ".join(result).strip()


def _normalize_heading_token(value: str) -> str:
    return re.sub(r"[^a-z]", "", value.lower())


def _sanitize_markdown_sections(answer_text: str) -> str:
    if not answer_text.strip():
        return ""

    # Ensure code fences aren't glued to following headings (e.g., "``` ## Heading")
    normalized_text = re.sub(
        r"```(\s*#+)",
        lambda match: "```\n" + match.group(1).lstrip(),
        answer_text,
    )

    buckets: Dict[str, List[str]] = {section: [] for section in VISION_SECTION_ORDER}
    preamble: List[str] = []
    current_section: Optional[str] = None
    seen: set[str] = set()
    in_code_block = False

    stop_after_space = False

    for line in normalized_text.splitlines():
        if stop_after_space:
            break
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
        if not in_code_block:
            heading_match = re.match(r"^\s{0,3}#{1,6}\s*(.+)$", line)
            if heading_match:
                normalized = _normalize_heading_token(heading_match.group(1))
                canonical = VISION_HEADING_LOOKUP.get(normalized)
                if canonical:
                    if canonical == "Complexity Analysis" and canonical in seen:
                        break
                    if canonical in seen:
                        current_section = None
                        continue
                    seen.add(canonical)
                    current_section = canonical
                    continue
        target_bucket = buckets.get(current_section) if current_section else preamble
        target_bucket.append(line)
        if (
            current_section == "Complexity Analysis"
            and not in_code_block
            and stripped.lower().startswith("space complexity")
        ):
            stop_after_space = True

    blocks: List[str] = []
    preamble_text = "\n".join(preamble).strip()
    if preamble_text:
        blocks.append(preamble_text)
    for heading in VISION_SECTION_ORDER:
        body = "\n".join(buckets[heading]).strip()
        if not body:
            continue
        blocks.append(f"## {heading}\n{body}")
        if heading == "Complexity Analysis":
            break
    sanitized = "\n\n".join(blocks).strip()
    return sanitized or answer_text.strip()


def _split_vision_answer(raw_text: str) -> tuple[str, str]:
    if not raw_text:
        return "", ""
    summary_raw: str
    answer_raw: str

    if VISION_SEPARATOR in raw_text:
        summary_raw, answer_raw = raw_text.split(VISION_SEPARATOR, 1)
    else:
        # Fallback 1: look for a standalone --- line
        split_candidate = re.split(r"^\s*-{3}\s*$", raw_text, maxsplit=1, flags=re.MULTILINE)
        if len(split_candidate) == 2:
            summary_raw, answer_raw = split_candidate
        else:
            # Fallback 2: split at the first Intuition heading
            heading_match = re.search(r"\n\s*##\s+Intuition", raw_text)
            if heading_match:
                idx = heading_match.start()
                summary_raw = raw_text[:idx]
                answer_raw = raw_text[idx:]
            else:
                summary_raw, answer_raw = raw_text, ""
    summary = _dedupe_sentences(summary_raw.strip())
    answer = _sanitize_markdown_sections(answer_raw.strip())
    return summary, answer


# ---------- PROMPT BUILDING ----------

SYSTEM_PROMPT = """
You are my private, expert interview assistant.

Your goal is to provide the **perfect response** for me to use immediately. You must adapt your output format based on the nature of my request.

### **MODES OF OPERATION**

1. **CODING & TECHNICAL TASKS** (Priority: High)
   - If I ask for code, syntax, or a specific implementation:
   - **IGNORE** length/bullet-point constraints.
   - Provide **optimal, production-ready code** inside Markdown code blocks (e.g., ```python ... ```).
   - Keep explanations minimal unless asked.

2. **EXPLICIT FORMATTING** (Priority: High)
   - If I ask for a specific format (e.g., "JSON", "Table", "One word", "List of 10"), **follow that instruction exactly**, overriding all default rules.

3. **LATEST INFORMATION** (Priority: High)
   - If I ask for current data (e.g., "Latest React version", "Stock price", "Recent news"):
   - You **MUST** use the `web_search` tool to fetch real-time data.
   - Do not rely on internal knowledge for time-sensitive facts.

4. **DEFAULT INTERVIEW MODE** (Priority: Low - Fallback)
   - For general behavioral or theoretical questions (e.g., "Tell me about yourself", "What is ACID?"):
   - Answer in **3–6 concise Markdown bullet points**.
   - Use natural, spoken English (confident, clear).
   - Implicitly use STAR method for behavioral questions.
   - Align with my Resume and JD Context provided below.

### **UNIVERSAL RULES (Apply to ALL modes)**
- **No Meta-Talk:** Never say "Here is the code", "As an AI", or "I have generated...". Just give the output.
- **Context Awareness:** If relevant, inject details from my Resume/Skills implicitly.
- **Directness:** Be ready to speak/paste immediately.
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


def stream_vision_answer(image_data_base64: str, session: SessionState) -> Generator[str, None, str]:
    """Stream a vision answer for a base64-encoded screenshot."""
    if not image_data_base64 or not image_data_base64.strip():
        raise ValueError("Image data is required for vision analysis.")

    detected_language = _detect_code_language(image_data_base64)

    prompt = """
You are a senior software engineer. Respond in exactly two parts using the delimiter "---SPLIT---".
Part 1: One concise question summarizing the problem.
---SPLIT---
Part 2: A detailed solution written in {language_hint}.
Use ONLY these headers in this exact order:
## Intuition
(Concise explanation of the approach)
## Algorithm
(Step-by-step logic)
## Implementation ({language_hint})
<most_optimal_solution_code in {language_hint}>
## Complexity Analysis
Time Complexity: <Big_O_Notation>, <Concise_Reason>
Space Complexity: <Big_O_Notation>, <Concise_Reason>

CRITICAL RULES:
1. Do NOT repeat the Summary or the Question in Part 2.
2. Do NOT repeat the headers or content.
3. STOP output immediately after the Space Complexity line. Do not generate any further text.
4. Be concise.
5. Provide the MOST OPTIMAL code solution.
6. The Implementation section must be valid {language_hint}.

Session context:
- Company: {company}
- Role: {role}
- Extra: {extra}
- Detected Language: {language_hint}
""".format(
        company=session.company,
        role=session.role,
        extra=session.extra_instructions or "None",
        language_hint=detected_language,
    )

    messages = [
        {
            "role": "system",
            "content": "Provide succinct, actionable answers. Use bullet points only if the content clearly benefits from it.",
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt.strip()},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{image_data_base64.strip()}"},
                },
            ],
        },
    ]

    stream = groq_client.chat.completions.create(
        model=VISION_MODEL_NAME,
        messages=messages,
        temperature=0.2,
        stream=True,
    )

    raw_output = ""
    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            raw_output += delta

    summary_text, answer_text = _split_vision_answer(raw_output.strip())
    separator = f"\n{VISION_SEPARATOR}\n"

    emitted = False
    for chunk in _chunk_preserving(summary_text, max_len=1200):
        if chunk:
            yield chunk
            emitted = True

    yield separator
    emitted = True

    for chunk in _chunk_preserving(answer_text, max_len=1600):
        if chunk:
            yield chunk
            emitted = True

    if not emitted and raw_output:
        yield raw_output

    return answer_text or summary_text or raw_output.strip()


# ---------- SIMPLE CLI TEST ----------

if __name__ == "__main__":
    # Example: quick test without STT
    # raw_resume = """Experienced Software Engineer with a strong background in backend development and mobile app development using Flutter. Proficient in Dart, Python, and Java, with hands-on experience in building scalable web services and cross-platform mobile applications. Skilled in RESTful API design, database management, and cloud technologies. Adept at problem-solving and delivering high-quality code in agile environments. Passionate about learning new technologies and improving software performance."""
    # raw_jd = """We are seeking a Software Engineer to join our dynamic team at Example Corp. The ideal candidate will have experience in backend development and mobile app development using Flutter. Responsibilities include designing and implementing scalable web services, collaborating with cross-functional teams, and contributing to the full software development lifecycle. Proficiency in Dart, Python, and Java is required, along with a strong understanding of RESTful API design and cloud technologies. The candidate should be able to work in an agile environment and have excellent problem-solving skills."""

    raw_resume = ""
    raw_jd = ""

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
