# Study guide — Career Copilot Lite

A tour of the tech stack and the three workflows that matter: **capture + embed**, **profile ingestion** (markdown and resume paths), and **match scoring** (profile evaluation), followed by the **LLM enhancement** path that produces the cleaned JD body and the row-preview one-liner.

The goal of this document is to give you a working mental model of the codebase by following data through it. File pointers throughout — read along with the code in a second pane.

---

## 1. Tech stack at a glance

| Layer | What we use | Why |
|---|---|---|
| Extension model | Manifest V3 (`manifest.json`) | Required for new Chrome extensions. Forces the service-worker pattern and the offscreen-document pattern below. |
| Build | esbuild (`build.mjs`) | Fast, zero-config bundling. Two passes: ESM for extension pages, IIFE for the Readability injector. |
| UI | Vanilla JS + a single HTML file (`src/sidepanel.html`, `src/sidepanel.js`) | No framework. The whole UI is small enough that a framework would be ceremony, not leverage. |
| Storage | IndexedDB (`src/db.js`) for data, `chrome.storage.local` for credentials | Vectors and large JD bodies belong in IDB; the BYOK key belongs alongside other credentials. Don't co-locate them. |
| Embeddings | `@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2` (q8 quantized, 384-dim) on ONNX Runtime Web | Local-first. The model is ~23 MB; downloaded once and cached in the browser Cache API. |
| Page extraction | Inline JSON-LD parser + `@mozilla/readability` + DOM-text fallback (`src/adapters/json-ld.js`) | Generic over thousands of ATS templates. No site-specific adapters. |
| Resume PDF | `pdfjs-dist` (`src/offscreen.js`) | Service workers can't host pdf.js's worker; offscreen doc can. |
| LLM | Groq HTTP API (`src/llm/groq-client.js`) | Optional, BYOK, on-demand only. Two endpoints: cleanup + resume extraction. |

Read these in order to bootstrap your mental model:

1. `manifest.json` — what permissions and contexts exist.
2. `build.mjs` — what gets shipped to `dist/`.
3. `src/constants.js` — the embedding model identity, status enums.
4. `src/db.js` — the five IndexedDB stores and their access functions.
5. Then the three context entry points: `src/background.js`, `src/offscreen.js`, `src/sidepanel.js`.

---

## 2. The MV3 three-context architecture

Manifest V3 forces Chrome extensions into a specific shape:

- **Service worker** (`src/background.js`) — short-lived, ephemeral. Chrome terminates it after ~30s of inactivity. Wakes on incoming messages and re-registers its listeners every time. **Cannot reliably host WASM** or long-lived modules — that's why we have the offscreen doc.
- **Offscreen document** (`src/offscreen.html` + `src/offscreen.js`) — a hidden DOM context that lives for the lifetime of the extension. We use it to host `@huggingface/transformers` (which needs WASM and dynamic imports) and `pdfjs-dist` (which spawns a Worker). Created lazily by the background SW via `chrome.offscreen.createDocument`.
- **Side panel** (`src/sidepanel.html` + `src/sidepanel.js`) — the UI. The side panel can only message the background SW; it never talks to the offscreen doc directly.

Visualization of who-talks-to-whom:

```
+--------------+ messages +-----------------+ messages +-----------------+
|  side panel  | <------> |  background SW  | <------> | offscreen doc   |
|  (UI)        |          |  (orchestrator) |          | (transformers,  |
|              |          |                 |          |  pdf.js)        |
+--------------+          +-----------------+          +-----------------+
                                  |
                                  | chrome.scripting.executeScript
                                  v
                          +--------------+
                          | target tab   |
                          | (extractor   |
                          |  function)   |
                          +--------------+
```

### Message routing

Every cross-context message carries a `target` field (`'background'`, `'offscreen'`, or `'sidepanel'`). Listeners filter on that field and return early if it's not theirs. Async paths use `sendResponse(...)` and `return true` from the listener.

`src/background.js` is the message hub. Read its `chrome.runtime.onMessage.addListener` block (around line 290 onward) to see every message type the system handles.

### Why offscreen exists

Two practical reasons:

1. The service worker is killed periodically. Reloading a 23 MB ML model on every wake would be unusable. The offscreen doc keeps the model in memory across SW restarts.
2. Service workers cannot reliably load WASM modules dynamically. `@huggingface/transformers` and `pdfjs-dist` both need this.

`ensureOffscreen()` in `background.js` uses `chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})` (Chrome 116+) to check for an existing doc, with a singleton-promise guard to serialize concurrent callers. Don't replace this with the older `hasDocument()` API.

---

## 3. The build (`build.mjs`)

Two esbuild passes plus a static-file copy:

1. **ESM pass** for `src/background.js`, `src/offscreen.js`, `src/sidepanel.js` — produces `dist/*.js`.
2. **IIFE pass** for `src/readability-inject.js` — produces `dist/readability.js`. **Must be IIFE**, not ESM, because `chrome.scripting.executeScript({files: [...]})` expects a classic script that mutates `globalThis`.

Static copies:

- HTML files and `manifest.json` to `dist/`.
- `node_modules/onnxruntime-web/dist/` WASM files to `dist/wasm/`. `src/embed.js` points `env.backends.onnx.wasm.wasmPaths` at `chrome.runtime.getURL('wasm/')` so ORT resolves WASM locally rather than fetching from a CDN (which CSP would block anyway).
- `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` to `dist/pdf.worker.mjs`.

`copyStatic()` wipes `dist/` first. `npm run watch` rebuilds incrementally on file changes; you still need to click reload on the extension card in `chrome://extensions` after each rebuild.

---

## 4. The five IndexedDB stores (`src/db.js`)

Database name: `careerpilot-lite`. Version: `2`.

| Store | Key | Holds |
|---|---|---|
| `jobs` | `id` | JD row metadata + match payload (no vector) |
| `embeddings` | `jd_id` | `{jd_id, vector: Float32Array, dims}` per JD |
| `profile_facts` | `id` | One atomic claim per row (from profile.md or resume) |
| `profile_embeddings` | `fact_id` | `{fact_id, vector: Float32Array, dims}` per fact |
| `meta` | `key` | Single key/value, currently just `profile_version` |

Two structural decisions to internalize:

**Vectors are stored separately from row metadata.** A list query that hydrates `Float32Array(384)` per row would be unusably slow once you have hundreds of rows. The list view never touches the embeddings store.

**Every embedding is tagged with `{model_id, model_version}`.** Currently `Xenova/all-MiniLM-L6-v2` + `q-v1`. If we swap models, we can detect mixed-version embeddings and force a reindex instead of silently producing nonsense scores.

**Match data lives on the `jobs` row.** The score, the `match_facts` list of `{fact_id, score}` pairs, the `match_computed_at` timestamp, and the `match_profile_version` string are scalars / IDs — small enough to not violate the no-vectors-on-jobs rule. The hydrated facts (with their full text) are looked up on demand from `profile_facts`.

---

## 5. Workflow A — Capture and embed a JD

### 5.1 Where it starts

Two entry points in the side panel:

- **Capture current tab** — message `{target: 'background', type: 'capture-tab'}`.
- **Paste capture** — message `{target: 'background', type: 'capture', text}`.

### 5.2 What the background does

For `capture-tab`:

1. Pre-injects `dist/readability.js` (an IIFE wrapping Mozilla's Readability) into the target tab as a classic script.
2. Calls `chrome.scripting.executeScript({target: {tabId}, func: extractJobPostingFromPage})`. This serializes `extractJobPostingFromPage` from `src/adapters/json-ld.js` and runs it in the page's isolated world. **The function must be self-contained — no imports, all helpers inlined** — because Chrome serializes only the function body.
3. Receives `{ok, jd | error}` back.

`src/adapters/json-ld.js` tries three strategies in order:

1. **Schema.org `JobPosting` JSON-LD** — the cleanest source. Walks `<script type="application/ld+json">` tags with lenient `@type` matching and `@graph` / `itemListElement` / `mainEntity` traversal. SPA retry: if no JSON-LD exists and body text is thin (`< 500` chars), wait up to 400ms for hydration before continuing.
2. **Readability fallback** — Mozilla's reader-view algorithm. Picks a single highest-scoring DOM subtree. **Cropping risk:** on Angular / React SPAs that split content across siblings (e.g. Interfolio), Readability can pass the 200-char floor with only half the JD. Guard: compare its output against DOM-text length; accept only if `readabilityText >= domText * 0.8`. Below that threshold, fall through to DOM-text.
3. **DOM-text fallback** — picks a `main`-ish container, strips `script/style/nav/header/footer/aside/form/[role=...]` chrome, applies an anchored CTA / cookie-line filter, and returns the text. Capture **preserves**; the optional LLM cleanup step is the layer that filters chrome — so there's no boilerplate-heading filter in capture itself anymore.

For paste capture: skip the page-injection step and feed the user's text straight into `persistCapture`.

### 5.3 Embedding flow

`persistCapture` in `src/background.js` (line ~175):

1. Dedup by URL — if a row already exists for this URL, return its id with `deduped: true`. Paste captures (no URL) are not deduped.
2. Build the embed input via `buildEmbedText()` — a header line `"Senior Backend Engineer · Acme · Berlin"` plus the raw body. The header isn't part of `raw_text`; it's only in the embedding input so the title and company contribute to the JD vector.
3. Call `embedViaOffscreen(embedInput)` — sends `{target: 'offscreen', type: 'embed', text}` to the offscreen doc.
4. The offscreen doc runs `embed(text)` from `src/embed.js`:
   - First call: loads the model (`pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {dtype: 'q8'})`). Cold-start is ~3–8s including the one-time download. Subsequent calls are warm (~50–100ms).
   - Returns `{vector: Float32Array(384), dims: 384}` after mean-pooling and L2-normalization.
5. `addJob()` writes the JD row to `jobs`, `putEmbedding()` writes the vector to `embeddings`.
6. `computeAndPersistMatch(rowId, vector)` runs the match scoring (see Workflow C below) and writes `match_score`, `match_facts`, `match_computed_at`, `match_profile_version` back onto the row.
7. Returns the new row id to the side panel, which refreshes the list.

Performance expectation on a healthy machine: cold-start `~3000–8000ms`, then `embed <100ms` per JD.

### 5.4 Why the embed input is built by `buildEmbedText`

`raw_text` is the deterministic capture — the user's source-of-truth body for "what was on this page." We never modify it. But for embedding purposes, prepending the title + company gives the JD vector a stronger signal than the body alone (which often opens with marketing chrome). The header is built from already-available structured fields — no inference, no LLM.

---

## 6. Workflow B — Profile ingestion (two paths)

The user has two ways to populate `profile_facts` + `profile_embeddings`:

### 6.1 Path 1: Markdown paste (deterministic, no LLM)

Entry: `{target: 'background', type: 'ingest-profile', markdown}`.

1. `parseProfileMarkdown(md)` in `src/profile/parse-markdown.js` chunks the markdown into atomic facts. Rules:
   - `## X` sets the current section.
   - `### X` sets the current subsection.
   - `- text` under those headings is one fact.
   - `[ADD]`-prefixed bullets and `[ ] / [x]` checkboxes are skipped. `[VERIFY]` is kept.
   - Blockquoted bullets (`> -`) are ignored — they're authoring conventions.
   - HTML comments are stripped.
2. `ingestFactList(facts)` in `src/background.js`:
   - Wipes the entire profile (`clearProfile()`). Profile ingestion is wipe-and-reload, not incremental — simpler and aligns with re-ingest being the user's "I edited my profile" flow.
   - For each fact: build embed input as `"section › subsection\ntext"` (the breadcrumb prefix gives the embedding context — "Primary language: Python" only makes sense when you know which project), embed it, write to `profile_facts` + `profile_embeddings`.
   - Per-fact `ingest-progress` ping back to the side panel.
   - Bumps `meta.profile_version` to `String(Date.now())` and fires `match-stale` so existing JD rows re-render with strikethrough chips.

This path **never calls the LLM**. It's fully deterministic over the user's authored markdown.

### 6.2 Path 2: Resume upload (LLM-extracted)

Entry: `{target: 'background', type: 'ingest-resume', kind: 'pdf' | 'text', base64?: ..., text?: ...}`.

Gated behind: a saved BYOK key + the LLM toggle on. Without those, the side panel surfaces an error pointing the user to the markdown-paste path.

1. **Stage 1 — get plain text.** For `kind: 'pdf'`, send the base64 to the offscreen doc (`{target: 'offscreen', type: 'parse-pdf'}`), which uses `pdfjs-dist` to extract text page-by-page. For `kind: 'text'`, use the input directly. Hard error if the result is `< 200` chars (likely a scanned PDF — we don't OCR).
2. **Stage 2 — LLM extraction.** `extractResumeFacts({rawText, settings})` in `src/llm/groq-client.js` posts to Groq with the resume system prompt. The prompt asks for a JSON object `{facts: [{section, subsection, text}, ...]}` with hard rules:
   - Every `text` field must be **verbatim** from the resume. No paraphrasing or summarization.
   - Section labels: `Experience`, `Education`, `Skills`, `Projects`, `Publications`, `Certifications`, `Awards`, `Open Source`, or other labels for uncommon sections.
   - Subsections: the specific role / school / project, with date range.
   - Facts are atomic — one bullet or one sentence each.
   - Drop boilerplate: page numbers, contact info, "References available on request", section title lines.
   Uses `response_format: {type: 'json_object'}` so Groq returns parseable JSON.
3. **Stage 3 — validate.** `validateResumeFacts(out.facts)` in `src/profile/parse-resume.js` filters anything off-shape and returns `{valid, dropped}`. Drops are logged but the call never throws.
4. **Stage 4 — converge.** Add an `order` field by array index, then call the same `ingestFactList()` used by the markdown path. From this point on, the two paths are identical.

The whole point of stages 3–4 is that the LLM path produces the **exact same data shape** as the markdown path, so the embedding and persistence loop is shared.

### 6.3 Why we don't allow the LLM to author fact text

Profile facts get embedded and become the source of truth for matching. If the LLM paraphrases "Reduced p99 latency from 480ms to 120ms" into "Improved performance significantly", the resulting embedding loses the specificity that drives a good match score. The verbatim rule isn't a stylistic preference — it's the foundation of the match quality.

---

## 7. Workflow C — Profile evaluation (match scoring)

### 7.1 The algorithm

`src/match.js` is one function:

```js
export async function computeMatch(jdVector, { topK = 10 } = {}) {
  const top = await profileCosineSearch(jdVector, { topK });
  const score = top.length
    ? top.reduce((s, f) => s + f.score, 0) / top.length
    : 0;
  return { score, top_facts: top };
}
```

The score is the **mean cosine similarity of the top-K profile facts** retrieved against the JD vector. Vectors are L2-normalized at embed time, so `cosine(a, b) === a · b`. Bounded `[0, 1]`.

### 7.2 Where it runs

`computeAndPersistMatch(jdId, jdVector)` in `src/background.js`:

- On every capture (right after `addJob` + `putEmbedding`).
- On every JD edit when the embedding-input fields change (title, company, location, raw_text). Detected via the `embedDirty` flag in the update handler.
- On explicit recompute: per-JD (`recompute-match`) or bulk (`recompute-all-matches`).

Reads:

- `meta.profile_version` — if null (no profile ingested), the function no-ops and returns null. Match scores only exist when there's a profile to match against.
- The JD's existing vector from `embeddings` if not passed in. Avoids re-embedding when the JD itself didn't change.

Writes (onto the `jobs` row):

- `match_score` — the float.
- `match_facts` — `[{fact_id, score}, ...]`. IDs only, not text. The list handler hydrates the text from `profile_facts` on demand.
- `match_computed_at` — milliseconds since epoch.
- `match_profile_version` — copy of `meta.profile_version` at compute time. **This is the staleness contract**: when the user re-ingests their profile, `meta.profile_version` bumps, and any row whose `match_profile_version` doesn't match the new value is shown with a strikethrough chip and a "Recompute" banner.

### 7.3 What's deliberately not in match.js

- No JD chunking (the body is embedded as one vector; the model truncates at 512 tokens internally).
- No asymmetric matching (no separate query / passage encoders — same model both sides).
- No learned weights or filters.

The simplicity is the feature. If you want to add gap analysis or skill-axis decomposition, do it in a new module — keep `match.js` as the boring baseline.

### 7.4 Where it surfaces

- **List row chip** (`renderMatchChip` in `src/sidepanel.js`) — colored by score band. Strikethrough when stale. The `?` chip means "no profile ingested yet."
- **Detail view breakdown** — full score plus the top facts grouped by section, with cosine values per fact. Lets you see exactly which claims pulled the score up or down.
- **Sort mode** — the list can be sorted by match score.

---

## 8. Workflow D — LLM enhancements

This is the project's only outbound LLM traffic outside resume extraction. Two uses of the same Groq client.

### 8.1 The cleanup endpoint

`src/llm/groq-client.js` → `cleanupJd({rawText, settings})`.

- **Endpoint**: `https://api.groq.com/openai/v1/chat/completions` (OpenAI-compatible).
- **Auth**: `Authorization: Bearer <user's BYOK key from chrome.storage.local>`.
- **Default model**: `llama-3.1-8b-instant`. **Recommended: `llama-3.3-70b-versatile`** — see the memory note below.
- **Inputs**: `raw_text` truncated to 16k chars (` [...truncated]` appended on overflow).
- **Output mode**: `response_format: {type: 'json_object'}`.

The prompt asks for a single JSON object with two fields:

```json
{
  "cleaned_markdown": "## Responsibilities\n- ...",
  "oneliner": "Senior backend engineer at Acme building payments infra in Go, remote US."
}
```

**`cleaned_markdown`** rules:
- Group bullets under `## ` section headings (Responsibilities, Requirements, Nice to have, Benefits, Compensation, etc.).
- Drop chrome: Apply buttons, cookie banners, sign-in prompts, footer text, EEO/diversity boilerplate, repeated CTAs.
- **Preserve every substantive sentence verbatim.** This is the locked design rule — the LLM can filter and reorganize, but never paraphrase or summarize the body.

**`oneliner`** rules (the project's only deliberate carve-out for authored prose):
- Plain text, no markdown.
- ≤ 140 chars.
- Factual: role + company + 1 distinguishing detail (domain, tech, location, seniority).
- No marketing language, no superlatives, no "we're looking for…".
- `null` if input is too sparse.

`sanitizeOneliner()` in `groq-client.js` strips leading markdown chrome, drops wrapping quotes, collapses whitespace, and hard-clamps to 140 chars with an ellipsis.

### 8.2 Where the cleanup output gets persisted

`'cleanup-job'` handler in `src/background.js`:

```js
const next = await updateJob(id, {
  cleaned_text: out.cleanedText,
  cleaned_at: Date.now(),
  oneliner: out.oneliner ?? null,
});
```

Both fields live on the `jobs` row. The detail view can render either `raw_text` or `cleaned_text` (toggle). The list view's `preview` field is derived in the `'list'` handler:

```js
preview: (typeof oneliner === 'string' && oneliner.trim()) || raw_text.slice(0, 200)
```

Cleaned rows show the LLM-generated one-liner; un-cleaned rows show a 200-char snippet of `raw_text`. The `.preview` row in the side panel is single-line with `text-overflow: ellipsis`.

### 8.3 Staleness contract

When the user edits a JD's `raw_text`, the update handler invalidates both fields:

```js
if (nextRawText !== existing.raw_text) {
  changes.cleaned_text = null;
  changes.cleaned_at = null;
  changes.oneliner = null;
}
```

This guarantees a row never shows a `cleaned_text` (or `oneliner`) that's older than its underlying `raw_text`. The user has to re-run cleanup to refresh both.

### 8.4 Failure modes

`cleanupJd` never throws. It returns one of:

- `{cleanedText: null, skipped: 'no-key' | 'disabled' | 'too-short'}` — gated off, no API call made.
- `{cleanedText: null, error: '<status> <statusText> — <provider msg>'}` — non-2xx response.
- `{cleanedText: null, error: 'malformed-response'}` — Groq returned 200 but the content was empty or missing `cleaned_markdown`.
- `{cleanedText: null, error: 'malformed-json'}` — JSON parse failed.
- `{cleanedText: null, error: 'timeout'}` — 30s elapsed.
- `{cleanedText, oneliner, latencyMs}` — success.

The side panel surfaces all error / skipped variants as a transient toolbar message; the row is unchanged on failure.

### 8.5 The carve-out, in one paragraph

This project's locked rule is "no rewrite, no generated prose, no body summaries — that all lives in the parent CareerPilot." The `oneliner` is a deliberate single-sentence exception: it's bounded (140 chars), constrained (factual + role + company), and not body content (it's a row preview, not a TL;DR of the JD body). `CLAUDE.md` documents this carve-out so future work doesn't see it as a precedent for longer-form generation. If you need a multi-paragraph summary, a cover letter, or any rewrite — you're in the wrong project; open `../CareerPilot`.

---

## 9. End-to-end: a captured JD's lifecycle

Putting workflows A, C, and D together for a single posting:

1. User clicks **Capture current tab**.
2. Background pre-injects Readability, then injects the extractor function via `chrome.scripting.executeScript`.
3. Extractor runs in the page; returns JSON-LD JD or Readability/DOM-text fallback.
4. Background calls `persistCapture`:
   - Dedup by URL.
   - `embedViaOffscreen(buildEmbedText(jd))` → 384-dim vector.
   - `addJob` + `putEmbedding`.
   - `computeAndPersistMatch` (only if a profile is ingested) → writes match score back to the row.
5. Side panel re-fetches the list; the new row appears with title, status picker, match chip, raw-text preview.
6. User clicks **Clean up JD**. Side panel sends `{type: 'cleanup-job', id}`.
7. Background calls `cleanupJd({rawText, settings})` → Groq returns `{cleaned_markdown, oneliner}`.
8. `updateJob` writes both fields. List handler's next call ships `preview = oneliner`. Side panel updates the cached row's preview and re-renders the list. Detail view auto-flips to "cleaned" body view.
9. User edits a field (e.g., adds a note). `'update-job'` handler runs. If `raw_text` was edited, both `cleaned_text` and `oneliner` are nulled out, the JD is re-embedded, and match is recomputed. If only metadata was edited, no LLM or embed work happens.

---

## 10. Inspecting the running extension

Each context has its own DevTools.

| Context | How to open | What to watch |
|---|---|---|
| Side panel | Right-click in the panel → Inspect | UI state, message round-trips. |
| Service worker | `chrome://extensions` → click the **service worker** link on the extension card | Capture pipeline logs, match-compute logs, `chrome.scripting.executeScript` errors. |
| Offscreen document | `chrome://extensions` → click **offscreen.html** (only appears after the first `ensureOffscreen` call) | Embed cold-start times, `[embed fetch]` logs on CSP misses, pdf.js parse errors. |
| Injected extractor | No separate DevTools. Errors surface in the executeScript return value, which background propagates to the side panel. | — |

If first capture fails with `Failed to fetch`, look in the offscreen console for `[embed fetch] FAILED <url>` — that names the exact CDN URL CSP blocked. Fix is usually adding a host to `connect-src` in `manifest.json`.

If capture fails with `Cannot access contents of the page`, the `<all_urls>` grant wasn't accepted at install. Reload the extension and accept.

---

## 11. Where to look next

After working through this guide, the most rewarding files to read in full are:

- **`src/background.js`** — the message hub and orchestrator. The whole capture / ingest / match / cleanup story is driven from here.
- **`src/adapters/json-ld.js`** — the only "page-side" code in the project. Self-contained because it gets serialized into the target page.
- **`src/llm/groq-client.js`** — short, deliberately tight, and shows the error-contract pattern (every function returns either success or a structured failure; nothing throws).
- **`src/match.js`** — five lines of working code. The simplicity is the architectural decision; if you want to extend matching, build a new module beside it rather than complicating this one.

`CLAUDE.md` is the rules-and-rationale doc. It explains *why* certain things are the way they are (why no rewrite UI, why offscreen for embeddings, why the `match_profile_version` staleness contract, why generic-extractor-first). Read it before changing the architecture.
