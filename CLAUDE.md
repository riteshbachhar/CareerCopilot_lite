# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project charter

Career Copilot Lite is a stripped-down sibling of the full Career Copilot project (at `../CareerPilot`). It ships a focused MVP: a **detailed job tracker** plus a **profile match checker**. Grounded rewrite, cover-letter generation, and the eval harness live in the parent project.

The LLM here is **optional, BYOK, and on-demand**, and is permitted for exactly two jobs:

1. **JD body cleanup** — reorganize the captured `raw_text` into proper markdown sections, dropping CTAs / cookie banners / boilerplate, while preserving every substantive sentence verbatim. As side products of that same call it returns one short factual `oneliner` (≤ 140 chars, role + company + 1 distinguishing detail, no marketing prose) used as the list-row preview, plus the application `deadline` and `posted_date` when the JD states them outright. **That one-liner is the only authored sentence this project permits.** The dates are extraction, not authoring: the prompt forbids computing a date from a relative phrase ("posted 3 days ago") and `sanitizeIsoDate` in `groq-client.js` drops anything that isn't a real calendar date within [2000, current year + 2].
2. **Resume parsing** at profile-upload time — split an uploaded CV into atomic `{section, subsection, text}` facts, where `text` is verbatim from the resume.

Out of scope (these are the reasons this project exists separately from the parent):
- Rewrite UI, cover-letter / outreach drafting, JD body TL;DRs, or any other LLM-generated user-facing prose.
- Eval harness or rewrite validators.
- Semantic JD search across the captured corpus.

When in doubt: does the feature ask the model to **filter and reorganize** content the user already captured, or to **author** new content (paraphrases, summaries, drafts)? Filter-and-reorganize → here. Author → parent.

## Commands

```bash
npm install                          # first time only
npm run build                        # one-shot build into dist/
npm run watch                        # rebuild on file changes (recommended during dev)
npm test                             # node --test tests/*.test.js
node --test tests/chunk-jd.test.js   # single test file
node --test --test-name-pattern="section weight" tests/match-coverage.test.js
npm run clean                        # rm -rf dist
```

There is no linter or typechecker configured. Tests cover the pure functions only (`chunk-jd`, `match-coverage`, `parse-markdown`, `parse-resume`, `import-jobs`, and `sanitizeIsoDate` from `llm/groq-client`) — anything touching `chrome.*` or IndexedDB is verified by the manual smoke test below.

`build.mjs` runs three things:
1. **ESM pass** for extension pages: `src/background.js`, `src/offscreen.js`, `src/sidepanel.js` → `dist/*.js`.
2. **IIFE pass** for `src/readability-inject.js` → `dist/readability.js`. Must be IIFE, not ESM, because `chrome.scripting.executeScript({files: [...]})` expects a classic script that mutates `globalThis`.
3. **`copyStatic()`** wipes `dist/`, copies the HTML files + `manifest.json`, copies ONNX Runtime Web WASM from `node_modules/onnxruntime-web/dist/` → `dist/wasm/`, and copies `pdf.worker.min.mjs` → `dist/pdf.worker.mjs`. Both workers are bundled locally rather than fetched: `src/embed.js` points `env.backends.onnx.wasm.wasmPaths` at `chrome.runtime.getURL('wasm/')`, and `offscreen.js` sets `pdfjsLib.GlobalWorkerOptions.workerSrc` to the local copy. CDN URLs would be blocked by `connect-src` anyway.

## Architecture

Three MV3 contexts. Crossing the boundaries between them is the whole design — understand the routing before editing any of them.

- **`src/sidepanel.html` / `src/sidepanel.js`** — the UI (~2k lines of vanilla JS, no framework). Talks *only* to the background service worker; never messages the offscreen document directly.
- **`src/background.js`** — service worker. Orchestrates the offscreen document lifecycle (`ensureOffscreen`), owns all IndexedDB access, runs the capture pipeline (`persistCapture`), chunks + embeds JDs (`chunkAndEmbedJD` / `rechunkAndEmbed`), computes match scores (`computeAndPersistMatch`), calls the Groq client, and injects the page extractor via `chrome.scripting.executeScript`. Ephemeral: Chrome terminates it after ~30s idle, so it must re-register listeners on every wake.
- **`src/offscreen.html` / `src/offscreen.js` / `src/embed.js`** — long-lived DOM context hosting `@huggingface/transformers` and `pdfjs-dist`. Service workers cannot reliably host WASM/dynamic imports or spawn pdf.js workers, which is the whole reason the offscreen document exists. **Do not move model inference or PDF parsing into `background.js`.**

### Module map

| File | Role |
|---|---|
| `src/adapters/json-ld.js` | Generic page extractor. `extractJobPostingFromPage` is self-contained (no imports, all helpers inlined) because Chrome serializes it to run inside the target page's isolated world. Tries schema.org `JobPosting` JSON-LD with lenient `@type` matching and `@graph` / `itemListElement` / `mainEntity` traversal, then Readability (pre-injected), then stripped `<main>` / `<article>` / body text. |
| `src/chunk-jd.js` | Pure. Splits a JD into atomic requirement-shaped chunks, tagged with the markdown section they came from. Drops boilerplate sections and chunk-level CTAs; 6–60 words per chunk, max 30 chunks. |
| `src/match-coverage.js` | Pure-ish (data layer injected). **The live scorer.** Section-weighted mean of per-chunk best profile matches. |
| `src/match.js` | The original symmetric top-K-mean baseline. **Dead code, kept for reference** — nothing imports it. |
| `src/db.js` | IndexedDB wrapper. Every store access goes through here. |
| `src/constants.js` | Model id/version, embedding dims, status enum + display order, sort modes. |
| `src/llm/groq-client.js` | `cleanupJd`, `extractResumeFacts`, `testGroqConnection`. Never throws — always returns `{..., skipped}` or `{..., error}`. |
| `src/llm/settings.js` | BYOK settings in `chrome.storage.local`. |
| `src/profile/parse-markdown.js` | Pure. Markdown → atomic facts (`section`, `subsection`, `text`, `order`). |
| `src/profile/parse-resume.js` | Pure. Validator for LLM resume-extraction output; filters off-shape facts, never throws. Emits the same shape `parse-markdown.js` does so both converge on one ingest loop. |
| `src/import-jobs.js` | Pure. CSV (minimal RFC-4180) / JSON backup file → normalized job rows. Collects per-row errors instead of throwing, so a partly-bad file still imports. |
| `src/readability-inject.js` | IIFE wrapper around `@mozilla/readability`. |

### Message routing

Every cross-context message carries a `target` field: `'background'` / `'offscreen'` / `'sidepanel'`. Listeners filter on `target` and `return false` early if it's not theirs. Async paths use `sendResponse(...)` + `return true`.

Background handles (all `{target: 'background', type}`): `capture`, `capture-tab`, `list`, `get`, `export-jobs`, `import-jobs`, `update-job`, `delete`, `set-status`, `ingest-profile`, `ingest-resume`, `profile-stats`, `list-profile-facts`, `clear-profile`, `recompute-match`, `recompute-all-matches`, `list-profiles`, `create-profile`, `rename-profile`, `delete-profile`, `set-default-profile`, `set-job-profile`, `get-llm-settings`, `set-llm-settings`, `clear-llm-settings`, `test-llm-connection`, `cleanup-job`.

Offscreen handles: `ping`, `embed`, `parse-pdf`.

Background pushes to the side panel (fire-and-forget, `.catch(() => {})`): `ingest-stage`, `ingest-progress`, `import-progress`, `recompute-progress`, `match-stale`.

Canonical flows:

- **Paste capture:** side panel `{type: 'capture', text}` → `persistCapture` → dedup by URL → `cleanupJd` (see below) → `chunkAndEmbedJD` (one `{target: 'offscreen', type: 'embed'}` round-trip *per chunk*) → `addJob` + `putJdChunks` → `computeAndPersistMatch`.
- **Capture-time cleanup:** `persistCapture` runs `cleanupJd` on the extracted text before chunking, after the dedup early-return (a deduped capture costs no LLM call). If it returns text, the row is stored with `cleaned_text` / `cleaned_at` / `oneliner` already set (plus any extracted dates folded into `structured_fields` by `withCleanupDates`, where deterministic JSON-LD `date_posted` / `valid_through` always win over the LLM's) and the chunks are cut from the cleaned markdown — so there is no second embed pass. If it returns `{skipped}` or `{error}`, the row falls through to the raw-text path unchanged, and the outcome rides back to the side panel on the capture response as `cleanup: {applied, skipped, error, latencyMs}`. The **Clean up JD ✨** button remains the manual retry for rows that landed raw. Bulk import does *not* go through `persistCapture` and stays LLM-free.
- **Capture current tab:** side panel `{type: 'capture-tab'}` → background injects `readability.js` into **all frames** → `executeScript({target: {tabId, allFrames: true}, func: extractJobPostingFromPage})` → `pickBestExtraction` ranks results `json-ld > readability > dom-text`, then top frame (`frameId === 0`) ahead of iframes, then longest description → `persistCapture`. The all-frames sweep exists because Greenhouse/Lever/Workable embeds put the real JD in a cross-origin iframe while the host frame is chrome; the top-frame tiebreak exists so LinkedIn sidebars don't steal the capture.
- **Edit:** `{type: 'update-job', id, patch}` → re-chunk + re-embed **only if** title / company / location / `raw_text` changed (`embedDirty`). Editing `notes`, `follow_up_at`, or `tags` must never invalidate the JD vector. A `raw_text` change also clears `cleaned_text` / `cleaned_at` / `oneliner`.
- **Cleanup:** `{type: 'cleanup-job', id}` → `cleanupJd` → store `cleaned_text` + `oneliner` + `withCleanupDates(structured_fields, out)` → `rechunkAndEmbed` (cleaned markdown chunks better than raw text) → `computeAndPersistMatch`.
- **Profile ingest (markdown or resume):** both converge on `ingestFactList(facts, profileId)` → `clearProfile(profileId)` → per fact: embed `"section › subsection\ntext"`, store to `profile_facts` + `profile_embeddings`, ping `ingest-progress` → bump that profile's `version` → fire `match-stale`. The resume path adds two stages before that: `parse-pdf` in offscreen (PDF sent as base64), then `extractResumeFacts` + `validateResumeFacts`.
- **Match recompute (bulk):** `{type: 'recompute-all-matches'}` sweeps stale rows, emitting `recompute-progress`.
- **Import:** `{type: 'import-jobs', text, format}` → `parseImportText` → per row: dedup by URL, `addJob`, apply metadata patch, re-chunk + re-embed, `computeAndPersistMatch`, ping `import-progress`. Match payload is deliberately *not* exported/imported — it's regenerated from the active profile.

### Offscreen document lifecycle

`ensureOffscreen()` uses `chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})` (Chrome 116+) to check for an existing doc before `chrome.offscreen.createDocument`. Do not swap this for the older `hasDocument()` API. A **singleton-promise guard** (`ensureOffscreenPromise`) serializes concurrent callers — otherwise two parallel requests on a cold start both see "no doc" and race on `createDocument`.

The offscreen doc persists across service-worker restarts. On the first embed it downloads `all-MiniLM-L6-v2` (~23 MB) and caches weights in the Cache API; subsequent embeds are warm (<100ms).

**Typed arrays don't survive `chrome.runtime` messaging reliably.** Embedding vectors cross as `Array.from(Float32Array)`; PDFs cross as base64. Keep it that way.

### Data model (IndexedDB `careerpilot-lite`, v4)

| Store | Key | Contents |
|---|---|---|
| `jobs` | `id` | Row metadata + match payload. Indexes: `timestamp`, `url` (non-unique — paste captures have `url: null`). |
| `jd_chunk_embeddings` | `[jd_id, chunk_index]` | One row per JD chunk: `chunk_text`, `section`, `vector`, `dims`, model tags. Index: `jd_id`. |
| `profiles` | `id` | `name`, `short_label`, `version`, `created_at`. Index: `created_at`. |
| `profile_facts` | `id` | `profile_id`, `section`, `subsection`, `text`, `order`, model tags. Indexes: `order`, `section`, `profile_id`. |
| `profile_embeddings` | `fact_id` | `profile_id`, `vector`, `dims`. Index: `profile_id`. |
| `meta` | `key` | Currently just `default_profile_id`. |
| `embeddings` | `jd_id` | **Legacy.** Whole-JD vectors from the pre-chunking era. Nothing writes it anymore; `deleteJob` still cascades it. |

Migrations live in one `onupgradeneeded` with cumulative `if (oldVersion < N)` blocks — v2 added the `url` index, v3 added multi-profile (including a data backfill that moves existing facts into a synthesized "My Profile" and replaces `meta.profile_version` with per-profile `version`), v4 added `jd_chunk_embeddings`. Adding a store means bumping `DB_VERSION` and appending a block; never edit an existing block.

Match payload on the `jobs` row (scalars + ids only — **no vectors in `jobs` rows**, deserialization cost on every list query is unacceptable):

```
match_score            number | null    // section-weighted mean of per-chunk best cosines
match_facts            [{chunk_index, chunk_text, weight, fact_id, score}] | null
match_computed_at      number | null
match_profile_id       string | null    // which profile it was scored against
match_profile_version  string | null    // that profile's version at compute time
match_algo_version     string | null    // 'coverage-v2'
profile_id             string | null    // per-JD profile override; null = use default
```

The hydrated facts (with `text`, `section`, `subsection`) are joined at read time in the `'get'` handler so the stored row stays small.

### Match pipeline

Capture → `chunkJD` → embed each chunk → `computeMatchCoverage(chunks, {profileId})`:

- For each JD chunk, find its single best-matching profile fact (`profileCosineSearchBatch`, `topKPerQuery: 1`).
- Weight by section: `nice-to-have | preferred | bonus` → 0.75, `requirements | qualifications | must-have` → 1.25, everything else (including `null` sections from raw-text fallback) → 1.0. Nice-to-have is tested **first** so "preferred qualifications" resolves to 0.75.
- Score = weighted mean of those per-chunk bests, bounded [0, 1].

This is asymmetric on purpose: it answers "does my profile cover the JD's requirements?" rather than "what are my closest profile sentences to the JD-as-a-bag?". The side panel splits `match_facts` at `score >= 0.45` into **Strong matches** and **Gaps**; the row chip tiers at `>= 0.6` strong / `>= 0.45` mid.

`computeAndPersistMatch` lazily re-chunks and re-embeds when a row has no cached chunks. That is what makes the bulk **Recompute** button silently upgrade pre-v4 rows: first hit re-embeds, subsequent recomputes are cheap.

### Freshness contract

A row's match is fresh iff **all** of: `match_score != null`, `match_profile_id` equals the row's active profile (`job.profile_id ?? defaultProfileId`), that profile's `version` still equals `match_profile_version`, and `match_algo_version` equals the current `MATCH_ALGO_VERSION`. Anything else renders as a strikethrough "stale" chip plus a **Recompute** banner.

`MATCH_ALGO_VERSION` (`'coverage-v2'`) is **declared in two places** — `src/background.js` and `src/sidepanel.js` — and they must stay in sync. Bump it whenever the scoring changes shape, so old scores at an incomparable scale get invalidated through the existing stale/recompute UX instead of silently coexisting.

## Locked design decisions

- **No rewrite, no generated prose, no body summaries.** See the charter above. If a feature needs the model to author or rewrite content beyond the `oneliner`, it belongs in the parent project.
- **Extraction is deterministic-only; cleanup is best-effort on top of it.** The page-extraction pipeline (JSON-LD → Readability → DOM text) never calls the LLM — what gets captured does not depend on a provider being up. Cleanup then runs automatically at capture *and* on the explicit button, in both cases only when a key is saved *and* the enable toggle is on. A missing key, network error, or provider failure must always degrade to the raw-text row plus a status message, never to a failed capture.
- **LLM failures never throw.** `groq-client.js` returns `{skipped}` or `{error}`. Keep that contract — the handlers rely on it to leave rows untouched.
- **The API key lives in `chrome.storage.local`, never IndexedDB.** IDB is the backup/export surface for captured JDs; credentials do not belong there, and it makes "Clear settings" a single delete.
- **Match scoring stays simple.** Section-weighted per-chunk coverage, no learned weights, no re-ranking model. Extensions go in new modules; don't grow `match-coverage.js` or `match.js`.
- **Generic extractor is the primary capture path.** Site-specific adapters are *refinements* (trim boilerplate, handle shadow DOM, pull richer metadata) — not the first line of coverage. Adding a per-site module requires justification: "the generic path produces unacceptable noise for this site because X."
- **Embedding versioning is mandatory.** Every vector carries `{model_id, model_version}` (currently `Xenova/all-MiniLM-L6-v2` + `q-v1`). Swapping models requires a reindex; tagging makes that detectable instead of silent corruption.
- **Model weights live in the Cache API**, not IndexedDB. Blobs belong in Cache API.
- **Notes / tags / follow-up dates are metadata, not JD content.** They must never enter the embed input or trigger re-embedding.
- **`<all_urls>` is dev-mode.** Same as the parent project — fine for dogfooding, must move to `optional_host_permissions` + `chrome.permissions.request({origins: [currentOrigin]})` before any Chrome Web Store submission.

## Permissions

`manifest.json` declares:

- **API permissions:** `sidePanel`, `offscreen`, `storage`, `scripting`.
- **Host permissions:** `<all_urls>` — required for the generic extractor to reach any job page.
- **CSP `connect-src`:** `huggingface.co` + `*.huggingface.co` + `*.hf.co` + `*.xethub.hf.co` + `cdn-lfs*.huggingface.co` (required for the Xet CDN redirects on first model download), plus `api.groq.com`. The LLM provider host exception is **for the cleanup and resume-parsing endpoints only**. Do not list any host whose only purpose would be a rewrite, summary, eval, or chat-completion-as-prose call.

## Development workflow

### Loading the extension

1. `npm run build` (or `npm run watch`).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.
3. Pin the toolbar icon; clicking it opens the side panel.
4. After rebuilds, click the reload icon on the extension's card.

This extension uses its own IndexedDB database (`careerpilot-lite`) and its own extension ID, so it runs side-by-side with the parent CareerPilot extension without sharing state.

**Heads up:** IndexedDB is scoped to the extension origin. `npm run build` only wipes `dist/` — captured JDs and ingested profiles survive rebuilds. Clicking **Remove** on the extension card is what wipes the database. "Clear browsing data" does **not** touch extension IndexedDB.

### Inspecting the three contexts

Each has its own DevTools window:

- **Side panel**: right-click inside the panel → Inspect.
- **Service worker**: extension card → click the **service worker** link. Watch here for `chrome.scripting.executeScript` errors, match-compute logs, and `[ingest-resume] dropped N malformed facts`.
- **Offscreen document**: extension card → click **offscreen.html** (appears only after the first `ensureOffscreen` call). Watch here for `[embed fetch] FAILED <url>` on CSP misses.
- **Injected extractor**: no separate DevTools — it runs in the target page's isolated world. Errors surface in `executeScript`'s return value, which `background.js` propagates to the side panel.

### Smoke test

1. Open the side panel. Open the **Profile** drawer (👤), create a profile, and load it — paste markdown (see `atomic_facts.md` for the expected shape) or upload a resume PDF (requires a Groq key). Progress bar fills; facts render grouped by section.
2. Navigate to a job page (Greenhouse, Lever, Ashby, an iframe-embedded board) → **Capture current tab**.
3. First capture: expect `cold-start ~3000–8000ms` (one-time model download). Subsequent captures: sub-second, one embed per chunk.
4. Captured JD appears with title, status picker, a colored match chip, and delete button.
5. Click the row → detail view shows a big % score and JD chunks split into **Strong matches** / **Gaps**.
6. Click **Clean up JD ✨** → body switches to cleaned markdown, row preview becomes the oneliner, and the score refreshes off the better-structured chunks.
7. Re-ingest an edited profile, or switch the default profile → chips go strikethrough-stale and the **Recompute** banner appears. Click it → all rows refresh.
8. Export JSON from the Profile drawer, then re-import it → rows dedup by URL, re-embed, and rescore.
9. Negative tests: capture on a non-job page (e.g. google.com) → fails cleanly with `no JobPosting schema + DOM text too short`. Delete all profiles → chips disappear; detail view shows "Add a profile to see match scores."

If the first capture fails with "Failed to fetch", check the offscreen console for `[embed fetch] FAILED <url>` — that surfaces the exact URL CSP blocked, and the fix is usually adding a host to `connect-src`. If capture fails with "Cannot access contents of the page", the `<all_urls>` grant wasn't accepted at install; reload the extension and accept the prompt.

## Relation to the parent CareerPilot project

This project is a sibling to `../CareerPilot`, not a fork. It was carved out so the tracker + match loop can be dogfooded independently of the rewrite workstream. If you need anything that produces new content the user reads (rewrites, cover letters, summaries / TL;DRs, citations rendered into application copy, eval harness, prompt-tuning loops), open the parent project. If you need anything tracker-, capture-, or match-shaped, work here — including LLM-assisted cleanup of captured JDs.
