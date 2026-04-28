// Groq client for JD body cleanup. The LLM's only job is to filter + reorganize
// captured text into clean markdown sections — never paraphrase, summarize,
// or invent content. Per CLAUDE.md, output is text but never "authored" prose.
//
// Failure modes (all return {cleanedText: null, error|skipped}, never throw):
//   - no key / disabled       → skipped: 'no-key' | 'disabled'
//   - very short input        → skipped: 'too-short'
//   - 30s timeout             → error: 'timeout'   (longer than test/structuring;
//                                                   cleanup output can be large)
//   - non-2xx response        → error: '<status> <statusText> — <provider msg>'
//   - empty response content  → error: 'malformed-response'

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 30_000;
const MAX_RAW_CHARS = 16_000;

const SYSTEM_PROMPT = `You are a job description cleaner. Your job is to take a raw, scraped job description body and reorganize it into clean, well-structured markdown — without changing the meaning of any sentence.

REQUIREMENTS:
- Group related bullets under proper section headings using "## " prefix (e.g. "## About the role", "## Responsibilities", "## Requirements", "## Nice to have", "## Benefits", "## Compensation"). Pick headings that fit the content; do not invent generic ones if the content does not warrant them.
- Drop content that is not part of the job description: "Apply now" buttons, cookie banners, sign-in prompts, navigation chrome, footer text, EEO/diversity boilerplate, repeated CTAs, "Share this job" links.
- Preserve all substantive job description content. Every responsibility, requirement, qualification, perk, and benefit listed in the input must appear somewhere in the output.
- Preserve sentence-level wording. You may fix obvious whitespace and capitalization issues, but DO NOT paraphrase, summarize, or rephrase any sentence.
- DO NOT invent or add content that is not present in the input.
- Output ONLY the cleaned markdown. No preamble ("Here is the cleaned..."), no commentary, no closing remarks, no code fences.`;

async function postChatCompletion({
  apiKey,
  model,
  messages,
  signal,
  maxTokens,
  jsonMode,
}) {
  const body = { model, temperature: 0, messages };
  if (maxTokens != null) body.max_tokens = maxTokens;
  // Groq (per OpenAI compat) rejects response_format=json_object unless
  // the prompt itself mentions JSON. Keep this opt-in.
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify(body),
  });
  return res;
}

async function readErrorDetail(res) {
  try {
    const j = await res.json();
    return j?.error?.message ? ` — ${j.error.message}` : '';
  } catch {
    return '';
  }
}

// Strip a wrapping ```markdown … ``` fence if the model added one despite the
// prompt asking it not to. Idempotent.
function stripCodeFence(s) {
  const trimmed = s.trim();
  const m = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

export async function cleanupJd({ rawText, settings }) {
  if (!settings?.apiKey) return { cleanedText: null, skipped: 'no-key' };
  if (!settings?.enabled) return { cleanedText: null, skipped: 'disabled' };
  if (typeof rawText !== 'string' || rawText.trim().length < 100) {
    return { cleanedText: null, skipped: 'too-short' };
  }

  const input =
    rawText.length > MAX_RAW_CHARS
      ? rawText.slice(0, MAX_RAW_CHARS) + '\n[…truncated]'
      : rawText;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await postChatCompletion({
      apiKey: settings.apiKey,
      model: settings.model || 'llama-3.1-8b-instant',
      signal: controller.signal,
      maxTokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: input },
      ],
    });
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      return { cleanedText: null, error: `${res.status} ${res.statusText}${detail}` };
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { cleanedText: null, error: 'malformed-response' };
    }
    return {
      cleanedText: stripCodeFence(content),
      latencyMs: Math.round(performance.now() - t0),
    };
  } catch (err) {
    if (err?.name === 'AbortError') return { cleanedText: null, error: 'timeout' };
    return { cleanedText: null, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

// Resume / CV extraction. Reads raw resume text and returns structured facts
// in the same shape parseProfileMarkdown produces, so the existing per-fact
// embed-and-store loop in background.js can ingest them unchanged.
//
// Returns the same failure-mode contract as cleanupJd:
//   { facts: [...], latencyMs }      on success
//   { facts: null, skipped: ... }    when LLM is gated off
//   { facts: null, error: ... }      on provider/network/parse errors

const RESUME_SYSTEM_PROMPT = `You are a resume / CV parser. Given the raw text of a resume, extract atomic facts and return a JSON object.

PRESERVE VERBATIM. Every fact's "text" field MUST be copied verbatim from the resume — same words, same wording. DO NOT paraphrase, summarize, or rephrase. You may fix only obvious whitespace / line-break artifacts from PDF extraction.

GROUPING:
- "section" is the top-level category. Use these exact labels when applicable: Experience, Education, Skills, Projects, Publications, Certifications, Awards, Open Source. Other labels are fine when the resume has uncommon sections (e.g. "Leadership", "Languages", "Volunteering").
- "subsection" is the specific role / school / project / publication, with date range when present. Examples: "Stripe — Senior Engineer (2020–2024)", "MIT — BS Computer Science (2014–2018)". Use null for facts that don't belong to a specific subsection (e.g. a flat Skills list).

ATOMIC FACTS:
- Each fact is one bullet or one sentence — the smallest meaningful claim.
- Multi-bullet items in the resume become multiple facts.
- A line like "Skills: Python, Go, TypeScript" should be ONE fact preserving the exact wording — do not split mid-phrase.

DROP these (boilerplate, not user claims):
- Page numbers, headers/footers, "References available on request"
- The applicant's name + contact details (phone, email, address, LinkedIn URL)
- Section title lines themselves (they become "section" / "subsection", not facts)

OUTPUT — return ONLY this JSON, no commentary, no preamble, no code fences:
{
  "facts": [
    { "section": "...", "subsection": "..." | null, "text": "..." }
  ]
}`;

const RESUME_MAX_INPUT_CHARS = 16_000;

export async function extractResumeFacts({ rawText, settings }) {
  if (!settings?.apiKey) return { facts: null, skipped: 'no-key' };
  if (!settings?.enabled) return { facts: null, skipped: 'disabled' };
  if (typeof rawText !== 'string' || rawText.trim().length < 200) {
    return { facts: null, skipped: 'too-short' };
  }

  const input =
    rawText.length > RESUME_MAX_INPUT_CHARS
      ? rawText.slice(0, RESUME_MAX_INPUT_CHARS) + '\n[…truncated]'
      : rawText;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const t0 = performance.now();
  try {
    const res = await postChatCompletion({
      apiKey: settings.apiKey,
      model: settings.model || 'llama-3.1-8b-instant',
      signal: controller.signal,
      maxTokens: 4000,
      jsonMode: true,
      messages: [
        { role: 'system', content: RESUME_SYSTEM_PROMPT },
        { role: 'user', content: input },
      ],
    });
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      return { facts: null, error: `${res.status} ${res.statusText}${detail}` };
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { facts: null, error: 'malformed-response' };
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { facts: null, error: 'malformed-json' };
    }
    return {
      facts: parsed,
      latencyMs: Math.round(performance.now() - t0),
    };
  } catch (err) {
    if (err?.name === 'AbortError') return { facts: null, error: 'timeout' };
    return { facts: null, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

// Tiny request used by the settings drawer's "Test connection" button.
export async function testGroqConnection(settings) {
  if (!settings?.apiKey) return { ok: false, error: 'no-key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const t0 = performance.now();
  try {
    const res = await postChatCompletion({
      apiKey: settings.apiKey,
      model: settings.model || 'llama-3.1-8b-instant',
      signal: controller.signal,
      maxTokens: 8,
      messages: [{ role: 'user', content: 'reply with the single word OK' }],
    });
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      return { ok: false, error: `${res.status} ${res.statusText}${detail}` };
    }
    return { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}
