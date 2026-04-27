# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Career Copilot Lite is a stripped-down sibling of the full Career Copilot project (at `../CareerPilot`). It ships a focused MVP: a **detailed job tracker** plus a **profile match checker**. There is no LLM provider, no grounded rewrite, no eval harness — those live in the parent project.

Shipped:
- **Capture** — MV3 scaffold, generic JSON-LD extractor with Readability + DOM-text fallback, `chrome.scripting.executeScript` on `<all_urls>`.
- **Embeddings & vector store** — `all-MiniLM-L6-v2` (q8, 384-dim) in offscreen via `@huggingface/transformers`; IndexedDB v1 with five stores (`jobs`, `embeddings`, `profile_facts`, `profile_embeddings`, `meta`).
- **Tracker** — capture → row with status picker (interested / applied / interviewing / offer / rejected / archived), text + status filter, inline detail view with edit (forced re-embed) and delete.
- **Profile ingestion** — markdown chunked into atomic facts via `src/profile/parse-markdown.js`; each fact is embedded with a `section › subsection` breadcrumb prefix and persisted to `profile_facts` + `profile_embeddings`.
- **Match checker** — every captured JD is scored against the user's profile facts on capture (and on edit). Score is the mean cosine of the top-10 facts retrieved against the JD vector. Surfaces as a colored chip on each list row and a full breakdown in detail view (score + top facts grouped by section). Re-ingesting the profile bumps a `profile_version`; stale rows show a strikethrough chip and a "Recompute" banner offers a one-click bulk refresh. Detail view also exposes per-JD "Recompute match".

Out of scope (intentionally — these are reasons this project exists separately from the parent):
- Any LLM call, prompt, or rewrite UI.
- Eval harness or rewrite validators.
- BYOK / API key settings drawer.
- Semantic JD search across the captured corpus.

## Architecture

Three MV3 contexts. Crossing the boundaries between them is the whole design — understand the routing before editing any of them.

- **`src/sidepanel.html` / `src/sidepanel.js`** — the UI. Talks only to the background service worker.
- **`src/background.js`** — service worker. Orchestrates the offscreen document lifecycle (`ensureOffscreen`), owns IndexedDB access, runs the capture pipeline (`persistCapture`), computes match scores (`computeAndPersistMatch`), and injects the page extractor via `chrome.scripting.executeScript`. Ephemeral: Chrome terminates it after ~30s idle, so it must re-register listeners on every wake.
- **`src/offscreen.html` / `src/offscreen.js` / `src/embed.js`** — long-lived DOM context hosting `@huggingface/transformers`. Service workers cannot reliably host WASM/dynamic imports, which is the whole reason the offscreen document exists in this design. **Do not move model inference into `background.js`.**
- **`src/adapters/json-ld.js`** — generic page extractor. `extractJobPostingFromPage` is a self-contained function (no imports, all helpers inlined) because Chrome serializes it to run inside the target page's isolated world. Tries schema.org `JobPosting` JSON-LD with lenient `@type` matching and `@graph` / `itemListElement` / `mainEntity` traversal, then falls back to Readability (pre-injected from `dist/readability.js`) and stripped `<main>` / `<article>` / body text.
- **`src/match.js`** — single function `computeMatch(jdVector, {topK})`. Reuses `profileCosineSearch` from `db.js`; no model calls, no LLM. Keep this file tiny — anything fancier (asymmetric matching, JD chunking, gap analysis) should be a separate module so this stays the simple baseline.
- **`src/profile/parse-markdown.js`** — markdown → atomic facts (section, subsection, text, order). Pure function, fully tested under `tests/parse-markdown.test.js`.

### Message routing

Every cross-context message carries a `target` field: `'background'` or `'offscreen'` or `'sidepanel'`. Listeners filter on `target` and return `false` early if it's not theirs. Responses use `sendResponse(...)` with `return true` for async paths.

Canonical flows:

- **Paste capture:** side panel `{target: 'background', type: 'capture', text}` → background `persistCapture` → background `{target: 'offscreen', type: 'embed', text}` → offscreen `pipeline(text)` → background writes `jobs` + `embeddings`, then `computeAndPersistMatch` if a profile exists → `sendResponse` back to side panel.
- **Capture current tab:** side panel `{target: 'background', type: 'capture-tab'}` → background pre-injects `readability.js` into the tab → `chrome.scripting.executeScript({target: {tabId}, func: extractJobPostingFromPage})` → function runs in page's isolated world → returns `{ok, jd | error}` → background `persistCapture` (same embed + match path).
- **Edit:** side panel `{target: 'background', type: 'update-job', id, patch}` → background re-embeds with `buildEmbedText` → updates `jobs` + `embeddings` → re-runs match.
- **Status change:** side panel `{target: 'background', type: 'set-status', id, status}` → `setStatus` in `db.js`.
- **Delete:** side panel `{target: 'background', type: 'delete', id}` → `deleteJob` wipes both `jobs` and `embeddings` in one transaction.
- **Profile ingest:** side panel `{target: 'background', type: 'ingest-profile', markdown}` → background `parseProfileMarkdown` → `clearProfile` (wipe-and-reload) → for each fact, embed `"section › subsection\ntext"` via offscreen and persist to `profile_facts` + `profile_embeddings` → fire `{target: 'sidepanel', type: 'ingest-progress', done, total}` ping per fact → bump `meta.profile_version` → fire `{target: 'sidepanel', type: 'match-stale', profile_version}` → final `sendResponse({ok, count, profile_version})`.
- **Match recompute (single):** side panel `{target: 'background', type: 'recompute-match', id}` → background reads existing JD vector from `embeddings` (no re-embed) → `computeAndPersistMatch` → updates row.
- **Match recompute (bulk):** side panel `{target: 'background', type: 'recompute-all-matches'}` → background sweeps every JD whose `match_profile_version` ≠ current `profile_version` → emits `recompute-progress` pings → returns `{updated, total}`.

The side panel never talks to the offscreen document directly — the background owns offscreen lifecycle.

### Offscreen document lifecycle

`ensureOffscreen()` in `background.js` uses `chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})` (Chrome 116+) to check for an existing doc before calling `chrome.offscreen.createDocument`. Do not swap this for the older `hasDocument()` API. A **singleton-promise guard** (`ensureOffscreenPromise`) serializes concurrent callers — otherwise two parallel requests on a cold start both see "no doc" and race on `createDocument`.

The offscreen doc persists across service-worker restarts. On the first embed it downloads `all-MiniLM-L6-v2` (~23 MB) and caches weights in the Cache API; subsequent embeds are warm (<100ms).

### Match data model

Match data is stored on the `jobs` row (not in a separate store):

```
match_score            number | null    // mean cosine of top-K facts
match_facts            [{fact_id, score}, ...] | null
match_computed_at      number | null
match_profile_version  string | null    // matches meta.profile_version when fresh
```

These are scalars + ids, not vectors — so they don't violate the "no vectors in `jobs` rows" rule. The hydrated facts (with `text`, `section`, `subsection`) are looked up at read time in the `'get'` handler so the row stays small.

## Locked design decisions

- **No LLM, no rewrite.** That entire workstream lives in the parent CareerPilot project. If you find yourself adding LLM calls, prompts, or BYOK settings here, stop and use the parent project instead — the whole point of this fork is to dogfood the tracker + match loop without the operational weight of a provider.
- **Match score is mean cosine of top-K profile facts.** No JD chunking, no asymmetric matching, no learned weights. The simplicity is the feature. Extensions go in new modules; don't add complexity to `src/match.js` itself.
- **Generic extractor is the primary capture path.** `src/adapters/json-ld.js` + Readability + DOM-text fallback covers the long tail. Site-specific adapters are *refinements* (trim boilerplate, handle shadow DOM, pull richer metadata) — not the first line of coverage. Adding a per-site module requires justification: "the generic path produces unacceptable noise for this site because X."
- **Embedding versioning is mandatory.** Every vector carries `{model_id, model_version}` (currently `Xenova/all-MiniLM-L6-v2` + `q-v1`). Swapping models requires a reindex; tagging makes that detectable instead of silent corruption.
- **IndexedDB layout.** Stores: `jobs` (row metadata + match payload), `embeddings` (Float32Array per JD), `profile_facts`, `profile_embeddings`, `meta` (single key/value, currently `profile_version`). Do **not** co-locate vectors in `jobs` rows — deserialization cost on every list query is unacceptable.
- **Model weights live in the Cache API**, not IndexedDB. Blobs belong in Cache API.
- **`profile_version` is the staleness contract.** Set on every successful `ingest-profile`; cleared on `clear-profile`. The side panel compares `job.match_profile_version` against the current `meta.profile_version` to decide whether a chip is fresh, stale, or never-computed.
- **`<all_urls>` is dev-mode.** Same as the parent project — fine for dogfooding, must move to `optional_host_permissions` + `chrome.permissions.request({origins: [currentOrigin]})` before any Chrome Web Store submission.

## Development workflow

**esbuild-based.** Source lives in `src/` and `manifest.json` at the repo root. The build emits a flat `dist/` that Chrome loads as the unpacked extension.

```bash
npm install          # first time only
npm run build        # one-shot build
npm run watch        # rebuild on file changes (recommended during dev)
npm test             # runs tests/parse-markdown.test.js
```

`build.mjs` runs:
1. **ESM pass** for extension pages: `src/background.js`, `src/offscreen.js`, `src/sidepanel.js` → `dist/*.js`.
2. **IIFE pass** for `src/readability-inject.js` → `dist/readability.js` (must be IIFE, not ESM, because `chrome.scripting.executeScript({files: [...]})` expects a classic script that mutates `globalThis`).

`copyStatic()` wipes `dist/`, copies the HTML files + `manifest.json`, and copies ONNX Runtime Web WASM files from `node_modules/onnxruntime-web/dist/` to `dist/wasm/`. `src/embed.js` points `env.backends.onnx.wasm.wasmPaths` at `chrome.runtime.getURL('wasm/')` so ORT resolves its WASM locally rather than hitting a CDN.

### Loading the extension

1. Run `npm run build` (or `npm run watch`).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.
3. Pin the toolbar icon; clicking it opens the side panel.
4. After rebuilds, click the reload icon on the extension's card in `chrome://extensions`.

This extension uses its own IndexedDB database (`careerpilot-lite`) and its own extension ID, so it can run side-by-side with the parent CareerPilot extension without sharing state.

**Heads up:** IndexedDB is scoped to the extension origin (`chrome-extension://<id>/`). `npm run build` only wipes `dist/` — your captured JDs and ingested profile survive rebuilds. Clicking **Remove** on the extension card is what would wipe the database. "Clear browsing data" in Chrome does **not** touch extension IndexedDB.

### Inspecting the three contexts

Each has its own DevTools window:

- **Side panel**: right-click inside the panel → Inspect.
- **Service worker**: extension card → click the **service worker** link. Watch here for `chrome.scripting.executeScript` errors and match-compute logs.
- **Offscreen document**: extension card → click **offscreen.html** (appears only after the first `ensureOffscreen` call). Watch here for `[embed fetch] FAILED <url>` logs on CSP misses.
- **Injected extractor**: no separate DevTools — the extractor runs in the target page's isolated world. If it throws, the error surfaces in `chrome.scripting.executeScript`'s return value, which background.js propagates to the side panel.

### Smoke test

1. Open the side panel from the toolbar icon. Open the **Profile** drawer (👤). Upload `profile.md` (root of repo) or paste markdown → progress bar fills → facts list renders grouped by section.
2. Navigate to a job page (Greenhouse, Lever, Ashby, branded careers pages). Click **Capture current tab**.
3. First capture: expect `cold-start ~3000–8000ms · embed <200ms` (one-time model download). Subsequent captures: no cold-start, `embed <100ms`.
4. Captured JD appears with title, status picker, **a colored match-score chip**, and delete button.
5. Click the row → detail view shows the JD body and a **Match section** with a big % score and top matching facts grouped by `section › subsection`.
6. Re-ingest a slightly edited profile → existing chips switch to a strikethrough "stale" state and a banner offers **Recompute**. Click it → all rows refresh.
7. Click **Recompute match** in the detail view of a single JD → just that one updates.
8. Negative tests: capture on a non-job page (e.g. google.com) → fails cleanly with `no JobPosting schema + DOM text too short`. Clear profile → all chips disappear; detail view shows "Ingest your profile to see match scores."

If the first capture fails with "Failed to fetch", check the offscreen DevTools console for `[embed fetch] FAILED <url>` — that surfaces the exact CDN URL CSP blocked, and the fix is usually adding a host to `connect-src` in `manifest.json`.

If capture fails with "Cannot access contents of the page", the `<all_urls>` grant wasn't accepted at install; reload the extension and accept the prompt.

## Permissions

`manifest.json` declares:

- **API permissions:** `sidePanel`, `offscreen`, `storage`, `scripting`.
- **Host permissions:** `<all_urls>` — required for the generic extractor to reach any job page. Dev-mode tradeoff; will migrate to `optional_host_permissions` + per-origin `chrome.permissions.request()` before Chrome Web Store submission.
- **CSP** `connect-src`: `huggingface.co` + `*.huggingface.co` + `*.hf.co` + `*.xethub.hf.co` + `cdn-lfs*.huggingface.co` (required for the Xet CDN redirects on first model download). No LLM provider hosts are listed — keep it that way.

## Relation to the parent CareerPilot project

This project is a sibling to `../CareerPilot`, not a fork. It was carved out so the tracker + match loop can be dogfooded independently of the rewrite workstream. If you need anything LLM-shaped (rewrite, citations, eval harness, prompt patches), open the parent project. If you need anything tracker- or match-shaped, work here.

When in doubt about which project a feature belongs to: does it require a model API call? If yes → parent. If no → here.
