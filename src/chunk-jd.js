// Split a JD into atomic, requirement-shaped chunks for asymmetric match
// scoring. Each chunk gets embedded individually and scored against the
// user's profile; the final match score is the mean of per-chunk best matches.
//
// Two paths:
//   1. cleaned_text (LLM cleanup output) — structured markdown with H2/H3
//      sections and bullets. Drop boilerplate sections, treat each bullet
//      and each prose paragraph (sentence-split) as a chunk.
//   2. raw_text fallback — split on blank lines into blocks; bullet blocks
//      yield one chunk per bullet, prose blocks sentence-split.
//
// Pure function. No I/O, no model calls.

// Sections that don't reflect candidate-fit. Matched against the heading
// text (post-`#` strip, lowercased). Conservative — if in doubt, keep.
const DROP_SECTION_RE =
  /^(benefits?|perks?|compensation|salary|pay|equal (employment|opportunity)|eeoc?|diversity|legal|disclosures?|how to apply|application( process|s)?|about (us|the company|the team)|company (overview|info)|why (us|join))\b/i;

// Chunk-level boilerplate filter. Run on trimmed chunk text, lowercased.
const BOILERPLATE_RE = new RegExp(
  [
    '^apply\\b',
    '^click here',
    '^submit (your )?(application|resume|cv)',
    '^(send|email).*(resume|cv|application)',
    '^equal (employment )?opportunity',
    '^we (are|\'re) an equal',
    '^all qualified applicants',
    '^this (position|role) (is|requires)',
    '^pursuant to',
    '^[\\W\\d]+$', // pure punctuation/digits
  ].join('|'),
  'i',
);

// URL-only chunks (after stripping common surrounding markdown) get dropped.
const URL_ONLY_RE = /^(https?:\/\/\S+|www\.\S+)$/i;

const MIN_WORDS = 6;
const MAX_WORDS = 60;
const MAX_CHUNKS = 30;

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

function looksLikeBoilerplate(s) {
  const trimmed = s.trim();
  if (!trimmed) return true;
  if (URL_ONLY_RE.test(trimmed)) return true;
  return BOILERPLATE_RE.test(trimmed);
}

// Split a paragraph of prose into sentences. Crude regex on terminal
// punctuation followed by whitespace + capital letter / digit / quote.
// Good enough for JD prose; Intl.Segmenter would be overkill.
function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripBulletMarker(line) {
  // -, *, •, –, —, or "1." / "1)" / "i." prefix
  return line.replace(/^\s*([-*•–—]|\d+[.)]|[ivx]+\.)\s+/i, '').trim();
}

function isBulletLine(line) {
  return /^\s*([-*•–—]|\d+[.)])\s+/.test(line);
}

function stripHeadingMarker(line) {
  return line.replace(/^#+\s*/, '').trim();
}

function isHeadingLine(line) {
  return /^#{1,6}\s+\S/.test(line);
}

// Walk lines, emit candidate chunks tagged with their current section
// context. Section = the most recent kept heading text (any level), or
// null when no heading has been seen (raw-text inputs without structure).
// Returns [{text, section}] before length / boilerplate filtering.
function extractCandidates(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let dropSection = false;
  let currentSection = null;
  let proseBuf = [];

  const flushProse = () => {
    if (!proseBuf.length) return;
    const para = proseBuf.join(' ').trim();
    proseBuf = [];
    if (!para || dropSection) return;
    // Always sentence-split prose so each chunk is a single requirement-shaped
    // claim, mirroring the per-bullet treatment. Sentences below MIN_WORDS
    // are dropped by the length filter; sentences above MAX_WORDS are
    // truncated there.
    for (const s of splitSentences(para)) {
      out.push({ text: s, section: currentSection });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushProse();
      continue;
    }
    if (isHeadingLine(line)) {
      flushProse();
      const header = stripHeadingMarker(line);
      dropSection = DROP_SECTION_RE.test(header);
      currentSection = dropSection ? null : header;
      continue;
    }
    if (isBulletLine(line)) {
      flushProse();
      if (dropSection) continue;
      out.push({ text: stripBulletMarker(line), section: currentSection });
      continue;
    }
    proseBuf.push(line.trim());
  }
  flushProse();
  return out;
}

// Apply length and boilerplate filters; truncate over-long chunks at the
// MAX_WORDS boundary rather than dropping (a 70-word bullet often still has
// useful signal in its first clause). Preserves the section tag from the
// candidate.
function filterAndTruncate(candidates) {
  const out = [];
  for (const c of candidates) {
    const trimmed = c.text.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    if (looksLikeBoilerplate(trimmed)) continue;
    const wc = wordCount(trimmed);
    if (wc < MIN_WORDS) continue;
    if (wc > MAX_WORDS) {
      const words = trimmed.split(/\s+/).slice(0, MAX_WORDS);
      out.push({ text: words.join(' ') + '…', section: c.section });
    } else {
      out.push({ text: trimmed, section: c.section });
    }
  }
  return out;
}

export function chunkJD({ raw_text, cleaned_text } = {}) {
  const text =
    typeof cleaned_text === 'string' && cleaned_text.trim()
      ? cleaned_text
      : typeof raw_text === 'string'
        ? raw_text
        : '';
  if (!text.trim()) return [];
  const candidates = extractCandidates(text);
  const filtered = filterAndTruncate(candidates);
  // Dedupe by text (cleaned text occasionally repeats lines). First
  // occurrence wins; section tag from that first occurrence is kept.
  const seen = new Set();
  const unique = [];
  for (const c of filtered) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    unique.push(c);
    if (unique.length >= MAX_CHUNKS) break;
  }
  return unique;
}
