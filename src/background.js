import {
  addJob,
  findJobByUrl,
  putJdChunks,
  getJdChunks,
  listJobs,
  getJob,
  setStatus,
  deleteJob,
  updateJob,
  addProfileFact,
  putProfileEmbedding,
  countProfileFacts,
  listProfileFacts,
  clearProfile,
  getProfileFact,
  addProfile,
  getProfile,
  listProfilesWithCounts,
  renameProfile,
  setProfileVersion,
  deleteProfileCascade,
  getDefaultProfileId,
  setDefaultProfileId,
} from './db.js';
import { extractJobPostingFromPage } from './adapters/json-ld.js';
import { parseProfileMarkdown } from './profile/parse-markdown.js';
import { chunkJD } from './chunk-jd.js';
import { computeMatchCoverage } from './match-coverage.js';
import { parseImportText } from './import-jobs.js';
import { JOB_STATUSES, DEFAULT_STATUS } from './constants.js';
import {
  cleanupJd,
  extractResumeFacts,
  testGroqConnection,
} from './llm/groq-client.js';
import { validateResumeFacts } from './profile/parse-resume.js';
import {
  getLlmSettings,
  setLlmSettings,
  clearLlmSettings,
} from './llm/settings.js';

const OFFSCREEN_URL = 'offscreen.html';

// Bumped whenever the match-scoring algorithm changes shape. Rows whose
// match_algo_version doesn't match this constant are treated as stale by
// the side panel, forcing a recompute via the existing strikethrough +
// Recompute UX rather than silently coexisting at incomparable scales.
const MATCH_ALGO_VERSION = 'coverage-v1';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

let ensureOffscreenPromise = null;
async function ensureOffscreen() {
  if (ensureOffscreenPromise) return ensureOffscreenPromise;
  ensureOffscreenPromise = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existing.length > 0) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification:
        'Host transformers.js embedding model off the service worker thread.',
    });
  })();
  try {
    await ensureOffscreenPromise;
  } finally {
    ensureOffscreenPromise = null;
  }
}

async function embedViaOffscreen(text) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'embed',
    text,
  });
  if (!resp?.ok) throw new Error(resp?.error ?? 'embed failed');
  return resp;
}

// Chunk a JD and embed every chunk via the offscreen pipeline. Returns
// the row payload ready for putJdChunks plus the first-chunk telemetry
// (cold-start ms only fires once per service-worker lifetime, on the
// first embed call). Used by capture, edit-with-raw_text-change, and
// the lazy-rechunk path inside computeAndPersistMatch.
async function chunkAndEmbedJD({ raw_text, cleaned_text }) {
  const chunks = chunkJD({ raw_text, cleaned_text });
  if (chunks.length === 0) {
    return { chunkRows: [], coldStartMs: 0, embedMs: 0, modelId: null, modelVersion: null };
  }
  let coldStartMs = 0;
  let embedMs = 0;
  let modelId = null;
  let modelVersion = null;
  const chunkRows = [];
  for (let i = 0; i < chunks.length; i++) {
    const out = await embedViaOffscreen(chunks[i]);
    if (i === 0) {
      coldStartMs = out.coldStartMs ?? 0;
      embedMs = out.embedMs ?? 0;
      modelId = out.modelId;
      modelVersion = out.modelVersion;
    }
    chunkRows.push({
      chunk_index: i,
      chunk_text: chunks[i],
      vector: out.vector,
      dims: out.dims,
      model_id: out.modelId,
      model_version: out.modelVersion,
    });
  }
  return { chunkRows, coldStartMs, embedMs, modelId, modelVersion };
}

// Re-chunk and re-embed a JD from its current row state, persisting the
// fresh chunks. Returns the row list (already sorted by chunk_index, in
// the same shape getJdChunks returns) so callers can pass them straight
// to computeMatchCoverage.
async function rechunkAndEmbed(jdId, job) {
  const { chunkRows } = await chunkAndEmbedJD({
    raw_text: job.raw_text,
    cleaned_text: job.cleaned_text ?? null,
  });
  await putJdChunks(jdId, chunkRows);
  return chunkRows;
}

// User tag input is untrusted — trim, dedupe (case-sensitive to preserve
// the user's chosen casing), drop empties, cap length and count. Server-side
// defense in depth; the side panel also validates.
function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, 30);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

function inferSeniority(title) {
  const t = (title ?? '').toLowerCase();
  if (/\b(staff|principal|distinguished|fellow)\b/.test(t)) return 'staff+';
  if (/\bsenior\b|\bsr\.?\b/.test(t)) return 'senior';
  if (/\b(lead|manager|director|head of)\b/.test(t)) return 'lead/mgr';
  if (/\b(junior|jr\.?|entry[- ]level|associate)\b/.test(t)) return 'junior';
  if (/\b(intern|internship)\b/.test(t)) return 'intern';
  return null;
}

// Notify the side panel of a non-numeric ingest stage ("parsing PDF…",
// "parsing with LLM…"). The numeric per-fact embed progress uses the
// existing ingest-progress message type with done/total fields.
function notifyIngestStage(stage) {
  chrome.runtime
    .sendMessage({ target: 'sidepanel', type: 'ingest-stage', stage })
    .catch(() => {});
}

// Shared per-fact ingest loop. Used by both ingest-profile (markdown facts)
// and ingest-resume (LLM-extracted facts). Wipes the named profile only,
// embeds every fact, stores it scoped to that profile, pings progress per
// fact, then bumps that profile's version and fires match-stale so the side
// panel can mark affected matches as stale.
async function ingestFactList(facts, profileId) {
  if (!profileId) throw new Error('ingestFactList: profileId required');
  await clearProfile(profileId);
  const total = facts.length;
  let done = 0;
  for (const fact of facts) {
    const breadcrumb = [fact.section, fact.subsection].filter(Boolean).join(' › ');
    const embedInput = [breadcrumb, fact.text].filter(Boolean).join('\n');
    const { vector, dims, modelId, modelVersion } = await embedViaOffscreen(embedInput);
    const row = await addProfileFact({
      profile_id: profileId,
      section: fact.section,
      subsection: fact.subsection,
      text: fact.text,
      order: fact.order,
      model_id: modelId,
      model_version: modelVersion,
    });
    await putProfileEmbedding({ fact_id: row.id, profile_id: profileId, vector, dims });
    done += 1;
    chrome.runtime
      .sendMessage({ target: 'sidepanel', type: 'ingest-progress', done, total })
      .catch(() => {});
  }
  const newVersion = String(Date.now());
  await setProfileVersion(profileId, newVersion);
  chrome.runtime
    .sendMessage({
      target: 'sidepanel',
      type: 'match-stale',
      profile_id: profileId,
      profile_version: newVersion,
    })
    .catch(() => {});
  return { count: done, profile_id: profileId, profile_version: newVersion };
}

// Resolve which profile this JD's match should be scored against.
// override > default > none.
async function resolveActiveProfileId(jobOrId) {
  const job = typeof jobOrId === 'string' ? await getJob(jobOrId) : jobOrId;
  if (job?.profile_id) return job.profile_id;
  return getDefaultProfileId();
}

// Compute and persist a match score for a JD. Reads the existing JD vector
// (cheap) instead of re-embedding. No-op when no profile exists at all.
// Writes match_profile_id alongside score / facts / version so freshness
// can be detected across profile-version bumps AND profile switches.
async function computeAndPersistMatch(jdId, profileIdOverride) {
  const job = await getJob(jdId);
  if (!job) return null;
  const profileId = profileIdOverride ?? (await resolveActiveProfileId(job));
  if (!profileId) return null; // no profiles exist yet
  const profile = await getProfile(profileId);
  if (!profile) return null; // dangling pointer, treat as no-op
  // Look for cached chunk vectors first; if missing (legacy row from before
  // the coverage-v1 algo, or a row whose chunks were evicted), re-chunk and
  // re-embed from the current raw_text/cleaned_text. This is what makes the
  // existing bulk Recompute button do the right thing for old rows: first
  // hit re-embeds, subsequent recomputes are cheap.
  let chunks = await getJdChunks(jdId);
  if (!chunks.length) {
    if (!job.raw_text) return null;
    chunks = await rechunkAndEmbed(jdId, job);
    if (!chunks.length) return null; // degenerate JD, all chunks filtered
  }
  const { score, top_facts } = await computeMatchCoverage(chunks, { profileId });
  await updateJob(jdId, {
    match_score: score,
    match_facts: top_facts,
    match_computed_at: Date.now(),
    match_profile_version: profile.version,
    match_profile_id: profileId,
    match_algo_version: MATCH_ALGO_VERSION,
  });
  return {
    score,
    top_facts,
    profile_id: profileId,
    profile_version: profile.version,
  };
}

async function persistCapture({
  url,
  title,
  company,
  location,
  description,
  source,
  structured_fields,
}) {
  const text = String(description ?? '').trim();
  if (!text) throw new Error('empty description');

  // Dedup: if a row with this URL already exists, surface the existing id
  // instead of inserting a phantom duplicate. URL-only is the safe baseline;
  // paste captures (url=null) are not deduped.
  if (url) {
    const existing = await findJobByUrl(url);
    if (existing) {
      return {
        id: existing.id,
        deduped: true,
        title: existing.title,
        company: existing.company,
      };
    }
  }

  const { chunkRows, coldStartMs, embedMs, modelId, modelVersion } =
    await chunkAndEmbedJD({ raw_text: text, cleaned_text: null });

  const row = await addJob({
    url: url ?? null,
    title: title ?? null,
    company: company ?? null,
    raw_text: text,
    structured_fields: {
      ...(structured_fields ?? {}),
      source: source ?? 'paste',
      location: location ?? null,
      seniority: inferSeniority(title),
    },
    model_id: modelId,
    model_version: modelVersion,
  });
  if (chunkRows.length) {
    await putJdChunks(row.id, chunkRows);
    await computeAndPersistMatch(row.id);
  }

  return {
    id: row.id,
    coldStartMs,
    embedMs,
    title: row.title,
    company: row.company,
  };
}

function firstLineAsTitle(text) {
  const firstLine = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return firstLine.slice(0, 120) || null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return false;

  if (msg.type === 'capture') {
    (async () => {
      try {
        const text = String(msg.text ?? '').trim();
        if (!text) throw new Error('empty text');
        const result = await persistCapture({
          url: msg.url ?? null,
          title: firstLineAsTitle(text),
          company: null,
          location: null,
          description: text,
          source: 'paste',
          structured_fields: null,
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'capture-tab') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('no active tab');

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['readability.js'],
          });
        } catch (err) {
          console.warn('[capture-tab] readability injection failed:', err);
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractJobPostingFromPage,
        });
        const extracted = results?.[0]?.result;
        if (!extracted?.ok) {
          throw new Error(extracted?.error ?? 'extraction failed');
        }

        const result = await persistCapture(extracted.jd);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'list') {
    (async () => {
      try {
        const jobs = await listJobs();
        const defaultProfileId = await getDefaultProfileId();
        const slim = jobs.map(({ raw_text, oneliner, match_facts, ...rest }) => ({
          ...rest,
          // Prefer the LLM oneliner from cleanup; fall back to a raw_text
          // snippet for rows that haven't been cleaned yet.
          preview:
            (typeof oneliner === 'string' && oneliner.trim()) ||
            raw_text.slice(0, 200),
        }));
        sendResponse({ ok: true, jobs: slim, default_profile_id: defaultProfileId });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  // Full job rows for the JSON-backup export path. Returns raw_text,
  // cleaned_text, and oneliner (which the slim 'list' handler strips) so
  // the export can round-trip back through the importer's re-embed path.
  // Match payload (match_score / match_facts / etc.) is intentionally
  // dropped — re-embed regenerates it from the active profile on import.
  if (msg.type === 'export-jobs') {
    (async () => {
      try {
        const jobs = await listJobs();
        const rows = jobs.map((j) => ({
          id: j.id,
          url: j.url,
          title: j.title,
          company: j.company,
          timestamp: j.timestamp,
          raw_text: j.raw_text,
          cleaned_text: j.cleaned_text ?? null,
          cleaned_at: j.cleaned_at ?? null,
          oneliner: j.oneliner ?? null,
          structured_fields: j.structured_fields ?? null,
          status: j.status,
          status_history: j.status_history ?? null,
          notes: j.notes ?? null,
          follow_up_at: j.follow_up_at ?? null,
          tags: j.tags ?? [],
        }));
        sendResponse({ ok: true, rows });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'get') {
    (async () => {
      try {
        const row = await getJob(msg.id);
        const defaultProfileId = await getDefaultProfileId();
        let hydrated_match_facts = null;
        if (row?.match_facts?.length) {
          hydrated_match_facts = await Promise.all(
            row.match_facts.map(async (f) => {
              const fact = f.fact_id ? await getProfileFact(f.fact_id) : null;
              return {
                chunk_index: f.chunk_index ?? null,
                chunk_text: f.chunk_text ?? null,
                fact_id: f.fact_id ?? null,
                score: f.score,
                section: fact?.section ?? null,
                subsection: fact?.subsection ?? null,
                text: fact?.text ?? '',
              };
            }),
          );
        }
        sendResponse({
          ok: true,
          job: row ?? null,
          hydrated_match_facts,
          default_profile_id: defaultProfileId,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'update-job') {
    (async () => {
      try {
        const { id, patch } = msg;
        const existing = await getJob(id);
        if (!existing) throw new Error(`job not found: ${id}`);

        const nextTitle = 'title' in patch ? (patch.title ?? null) : existing.title;
        const nextCompany =
          'company' in patch ? (patch.company ?? null) : existing.company;
        const nextLocation =
          'location' in patch
            ? (patch.location ?? null)
            : existing.structured_fields?.location ?? null;
        const nextRawText =
          'raw_text' in patch
            ? String(patch.raw_text ?? '').trim()
            : existing.raw_text;
        if (!nextRawText) throw new Error('raw_text cannot be empty');

        // Re-embed only when an embed-input field actually changed.
        // Notes and follow_up_at are metadata: editing them must not
        // invalidate the JD vector or trigger match recomputation.
        const embedDirty =
          nextTitle !== existing.title ||
          nextCompany !== existing.company ||
          nextLocation !== (existing.structured_fields?.location ?? null) ||
          nextRawText !== existing.raw_text;

        const changes = {
          title: nextTitle,
          company: nextCompany,
          raw_text: nextRawText,
          structured_fields: {
            ...(existing.structured_fields ?? {}),
            location: nextLocation,
            seniority: inferSeniority(nextTitle),
          },
        };
        if ('notes' in patch) changes.notes = patch.notes ?? null;
        if ('follow_up_at' in patch) changes.follow_up_at = patch.follow_up_at ?? null;
        if ('tags' in patch) changes.tags = normalizeTags(patch.tags);
        // Invalidate cached LLM cleanup when raw_text changed — the cleaned
        // version (and the oneliner derived from it) are stale once the
        // source text moves.
        if (nextRawText !== existing.raw_text) {
          changes.cleaned_text = null;
          changes.cleaned_at = null;
          changes.oneliner = null;
        }

        if (embedDirty) {
          // raw_text changes invalidate cleaned_text earlier in this handler,
          // so the chunker correctly falls back to raw-text mode below.
          const cleanedForChunk =
            'cleaned_text' in changes
              ? (changes.cleaned_text ?? null)
              : (existing.cleaned_text ?? null);
          const { chunkRows, modelId, modelVersion } = await chunkAndEmbedJD({
            raw_text: nextRawText,
            cleaned_text: cleanedForChunk,
          });
          await putJdChunks(id, chunkRows);
          changes.model_id = modelId ?? existing.model_id;
          changes.model_version = modelVersion ?? existing.model_version;
        }

        const next = await updateJob(id, changes);
        if (embedDirty) await computeAndPersistMatch(id);
        sendResponse({
          ok: true,
          id,
          title: next.title,
          company: next.company,
          embedded: embedDirty,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'delete') {
    (async () => {
      try {
        await deleteJob(msg.id);
        sendResponse({ ok: true, id: msg.id });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'set-status') {
    (async () => {
      try {
        const row = await setStatus(msg.id, msg.status);
        sendResponse({ ok: true, id: row.id, status: row.status });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ingest-profile') {
    (async () => {
      try {
        const profileId = msg.profile_id;
        if (!profileId) throw new Error('ingest-profile: profile_id required');
        const profile = await getProfile(profileId);
        if (!profile) throw new Error(`profile not found: ${profileId}`);
        const markdown = String(msg.markdown ?? '');
        const facts = parseProfileMarkdown(markdown);
        if (facts.length === 0) throw new Error('no facts parsed from markdown');
        const result = await ingestFactList(facts, profileId);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ingest-resume') {
    (async () => {
      try {
        const profileId = msg.profile_id;
        if (!profileId) throw new Error('ingest-resume: profile_id required');
        const profile = await getProfile(profileId);
        if (!profile) throw new Error(`profile not found: ${profileId}`);
        const settings = await getLlmSettings();
        if (!settings.apiKey || !settings.enabled) {
          throw new Error('Resume upload requires the LLM. Add a key in Settings ⚙ and enable it, or use the Advanced markdown paste path.');
        }

        // Stage 1: get plain text (from the request, or by parsing a PDF in offscreen).
        let rawText;
        if (msg.kind === 'pdf') {
          if (typeof msg.base64 !== 'string' || !msg.base64.length) {
            throw new Error('PDF payload missing');
          }
          notifyIngestStage('parsing PDF…');
          await ensureOffscreen();
          const parseResp = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'parse-pdf',
            base64: msg.base64,
          });
          if (!parseResp?.ok) {
            throw new Error(`PDF parse failed: ${parseResp?.error ?? 'unknown'}`);
          }
          rawText = parseResp.text ?? '';
          if (rawText.trim().length < 200) {
            throw new Error("Couldn't read text from this PDF — it may be a scanned image. Try a text-based PDF or paste markdown under Advanced.");
          }
        } else if (msg.kind === 'text') {
          rawText = String(msg.text ?? '');
          if (rawText.trim().length < 200) throw new Error('Resume text too short.');
        } else {
          throw new Error(`unknown ingest-resume kind: ${msg.kind}`);
        }

        // Stage 2: LLM extraction.
        notifyIngestStage('parsing with LLM…');
        const out = await extractResumeFacts({ rawText, settings });
        if (!out.facts) {
          if (out.skipped) throw new Error(`LLM skipped: ${out.skipped}`);
          throw new Error(`LLM error: ${out.error ?? 'unknown'}`);
        }

        // Stage 3: validate. Drop nothing-shaped, never throw.
        const { valid, dropped } = validateResumeFacts(out.facts);
        if (valid.length === 0) {
          throw new Error(
            "Couldn't extract facts from this resume — try saving as text and pasting under Advanced.",
          );
        }
        if (dropped.length) {
          console.warn('[ingest-resume] dropped', dropped.length, 'malformed facts:', dropped.slice(0, 5));
        }

        // Stage 4: existing per-fact embed-and-store loop. Adds order based
        // on array position so retrieval ordering matches the resume layout.
        const factsWithOrder = valid.map((f, i) => ({ ...f, order: i }));
        const result = await ingestFactList(factsWithOrder, profileId);
        sendResponse({
          ok: true,
          ...result,
          dropped: dropped.length,
          llmLatencyMs: out.latencyMs,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'profile-stats') {
    (async () => {
      try {
        // Total fact count across all profiles. The toolbar dot fires when
        // count > 0, so this aggregate is what it needs.
        const count = await countProfileFacts();
        sendResponse({ ok: true, count });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'list-profile-facts') {
    (async () => {
      try {
        const profileId = msg.profile_id;
        if (!profileId) throw new Error('list-profile-facts: profile_id required');
        const facts = await listProfileFacts(profileId);
        sendResponse({ ok: true, facts });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'clear-profile') {
    (async () => {
      try {
        const profileId = msg.profile_id;
        if (!profileId) throw new Error('clear-profile: profile_id required');
        await clearProfile(profileId);
        // Bump version so any cached match against this profile is now stale.
        const newVersion = String(Date.now());
        await setProfileVersion(profileId, newVersion);
        chrome.runtime
          .sendMessage({
            target: 'sidepanel',
            type: 'match-stale',
            profile_id: profileId,
            profile_version: newVersion,
          })
          .catch(() => {});
        sendResponse({ ok: true, profile_id: profileId, profile_version: newVersion });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'recompute-match') {
    (async () => {
      try {
        const { id } = msg;
        const row = await getJob(id);
        if (!row) throw new Error(`job not found: ${id}`);
        const result = await computeAndPersistMatch(id);
        if (!result) {
          sendResponse({ ok: true, score: null });
          return;
        }
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'recompute-all-matches') {
    (async () => {
      try {
        const defaultId = await getDefaultProfileId();
        if (!defaultId) {
          sendResponse({ ok: true, updated: 0 });
          return;
        }
        // Cache profile versions so the freshness check is one read.
        const profilesList = await listProfilesWithCounts();
        const versionById = new Map(profilesList.map((p) => [p.id, p.version]));

        const jobs = await listJobs();
        const stale = jobs.filter((j) => {
          if (j.match_algo_version !== MATCH_ALGO_VERSION) return true;
          const activeId = j.profile_id ?? defaultId;
          if (j.match_profile_id !== activeId) return true;
          const expectedVersion = versionById.get(activeId);
          return j.match_profile_version !== expectedVersion;
        });
        let done = 0;
        for (const j of stale) {
          await computeAndPersistMatch(j.id);
          done += 1;
          chrome.runtime
            .sendMessage({
              target: 'sidepanel',
              type: 'recompute-progress',
              done,
              total: stale.length,
            })
            .catch(() => {});
        }
        sendResponse({ ok: true, updated: done, total: stale.length });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  // Re-ingest jobs from a CSV or JSON backup file. Each row is parsed,
  // deduped against existing rows by URL, then run through the same
  // chunk-and-embed path as a fresh capture so the new install ends up
  // with identical chunk vectors / match scores. Per-row failures are
  // collected and surfaced; one bad row never aborts the rest of the file.
  if (msg.type === 'import-jobs') {
    (async () => {
      try {
        const { text, format } = msg;
        const parsed = parseImportText(text, { format });
        const total = parsed.rows.length;
        const errors = [...parsed.errors];
        if (!total) {
          sendResponse({ ok: true, imported: 0, skipped: 0, failed: 0, total: 0, errors });
          return;
        }
        let imported = 0;
        let skipped = 0;
        let failed = 0;
        let done = 0;
        for (const row of parsed.rows) {
          try {
            // Dedupe by URL — match the existing capture pattern. Paste
            // captures (no URL) bypass dedupe, so paste-imported rows can
            // legitimately appear multiple times if the file has them.
            if (row.url) {
              const existing = await findJobByUrl(row.url);
              if (existing) {
                skipped += 1;
                done += 1;
                chrome.runtime
                  .sendMessage({
                    target: 'sidepanel',
                    type: 'import-progress',
                    done,
                    total,
                    imported,
                    skipped,
                    failed,
                  })
                  .catch(() => {});
                continue;
              }
            }
            const status = JOB_STATUSES.includes(row.status)
              ? row.status
              : DEFAULT_STATUS;
            const created = await addJob({
              url: row.url,
              title: row.title,
              company: row.company,
              raw_text: row.raw_text,
              structured_fields: row.structured_fields,
              model_id: null,
              model_version: null,
            });
            // Apply imported metadata that addJob defaults differently.
            // status_history from the import overrides the single-entry
            // default; if absent, we leave the default in place.
            const patch = {};
            if (row.timestamp) patch.timestamp = row.timestamp;
            if (status !== DEFAULT_STATUS || row.status_history) {
              patch.status = status;
              patch.status_history = row.status_history ?? [
                { status, at: row.timestamp ?? Date.now() },
              ];
            }
            if (row.notes) patch.notes = row.notes;
            if (row.follow_up_at) patch.follow_up_at = row.follow_up_at;
            if (row.tags?.length) patch.tags = normalizeTags(row.tags);
            if (row.cleaned_text) {
              patch.cleaned_text = row.cleaned_text;
              patch.cleaned_at = row.timestamp ?? Date.now();
            }
            if (row.oneliner) patch.oneliner = row.oneliner;
            if (Object.keys(patch).length) await updateJob(created.id, patch);

            // Re-embed: chunk → embed each → store. Use cleaned_text when
            // present so the chunker takes advantage of structured markdown.
            const { chunkRows, modelId, modelVersion } = await chunkAndEmbedJD({
              raw_text: row.raw_text,
              cleaned_text: row.cleaned_text,
            });
            if (chunkRows.length) {
              await putJdChunks(created.id, chunkRows);
              await updateJob(created.id, {
                model_id: modelId,
                model_version: modelVersion,
              });
              await computeAndPersistMatch(created.id);
            }
            imported += 1;
          } catch (err) {
            failed += 1;
            errors.push({
              where: row.url ?? row.title ?? '(row)',
              message: String(err?.message ?? err),
            });
          }
          done += 1;
          chrome.runtime
            .sendMessage({
              target: 'sidepanel',
              type: 'import-progress',
              done,
              total,
              imported,
              skipped,
              failed,
            })
            .catch(() => {});
        }
        sendResponse({ ok: true, imported, skipped, failed, total, errors });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'get-llm-settings') {
    (async () => {
      try {
        const settings = await getLlmSettings();
        // Don't ship the full key back to the side panel by default; expose
        // a hasKey hint and the last 4 chars so the UI can confirm a key is
        // saved without splashing it across the DOM.
        const { apiKey, ...rest } = settings;
        sendResponse({
          ok: true,
          settings: {
            ...rest,
            hasKey: !!apiKey,
            keyTail: apiKey ? apiKey.slice(-4) : '',
          },
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'set-llm-settings') {
    (async () => {
      try {
        const next = await setLlmSettings(msg.patch ?? {});
        const { apiKey, ...rest } = next;
        sendResponse({
          ok: true,
          settings: {
            ...rest,
            hasKey: !!apiKey,
            keyTail: apiKey ? apiKey.slice(-4) : '',
          },
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'clear-llm-settings') {
    (async () => {
      try {
        await clearLlmSettings();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'test-llm-connection') {
    (async () => {
      try {
        const settings = await getLlmSettings();
        const result = await testGroqConnection(settings);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  // ---------- Profile management ----------

  if (msg.type === 'list-profiles') {
    (async () => {
      try {
        const profiles = await listProfilesWithCounts();
        const defaultProfileId = await getDefaultProfileId();
        sendResponse({ ok: true, profiles, default_profile_id: defaultProfileId });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'create-profile') {
    (async () => {
      try {
        const profile = await addProfile({
          name: msg.name,
          short_label: msg.short_label,
        });
        // First profile created → automatically becomes default.
        const existingDefault = await getDefaultProfileId();
        if (!existingDefault) {
          await setDefaultProfileId(profile.id);
        }
        sendResponse({ ok: true, profile });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'rename-profile') {
    (async () => {
      try {
        const { id, name, short_label } = msg;
        if (!id) throw new Error('rename-profile: id required');
        const next = await renameProfile(id, { name, short_label });
        sendResponse({ ok: true, profile: next });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'delete-profile') {
    (async () => {
      try {
        const { id } = msg;
        if (!id) throw new Error('delete-profile: id required');
        const profiles = await listProfilesWithCounts();
        if (profiles.length <= 1) {
          throw new Error('Cannot delete the last profile. Add another profile first, or use Clear contents.');
        }
        const isDefault = profiles.find((p) => p.id === id)?.is_default;
        // Cascade-delete profile + facts + embeddings + clears default ptr if needed.
        await deleteProfileCascade(id);
        // If we deleted the default, promote the most recently created remaining profile.
        if (isDefault) {
          const remaining = profiles.filter((p) => p.id !== id);
          const newDefault = remaining[remaining.length - 1] ?? remaining[0];
          if (newDefault) await setDefaultProfileId(newDefault.id);
        }
        // Revert any per-JD overrides pointing at the deleted profile.
        const jobs = await listJobs();
        for (const j of jobs) {
          if (j.profile_id === id) {
            await updateJob(j.id, { profile_id: null });
          }
        }
        // Fire match-stale so the side panel re-evaluates affected rows.
        chrome.runtime
          .sendMessage({
            target: 'sidepanel',
            type: 'match-stale',
            profile_id: id,
            profile_version: null,
          })
          .catch(() => {});
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'set-default-profile') {
    (async () => {
      try {
        const { id } = msg;
        if (!id) throw new Error('set-default-profile: id required');
        const profile = await getProfile(id);
        if (!profile) throw new Error(`profile not found: ${id}`);
        await setDefaultProfileId(id);
        // Default change can stale every JD without an override.
        chrome.runtime
          .sendMessage({
            target: 'sidepanel',
            type: 'match-stale',
            profile_id: null,
            profile_version: null,
          })
          .catch(() => {});
        sendResponse({ ok: true, default_profile_id: id });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'set-job-profile') {
    (async () => {
      try {
        const { job_id, profile_id } = msg;
        if (!job_id) throw new Error('set-job-profile: job_id required');
        const existing = await getJob(job_id);
        if (!existing) throw new Error(`job not found: ${job_id}`);
        // Validate the override (null is fine, means "use default").
        if (profile_id) {
          const p = await getProfile(profile_id);
          if (!p) throw new Error(`profile not found: ${profile_id}`);
        }
        await updateJob(job_id, { profile_id: profile_id ?? null });
        const result = await computeAndPersistMatch(job_id);
        const next = await getJob(job_id);
        sendResponse({
          ok: true,
          job: next,
          score: result?.score ?? null,
          profile_id: result?.profile_id ?? null,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'cleanup-job') {
    (async () => {
      try {
        const { id } = msg;
        const row = await getJob(id);
        if (!row) throw new Error(`job not found: ${id}`);
        const settings = await getLlmSettings();
        const out = await cleanupJd({ rawText: row.raw_text, settings });
        if (!out.cleanedText) {
          sendResponse({ ok: true, cleaned: false, info: out });
          return;
        }
        const next = await updateJob(id, {
          cleaned_text: out.cleanedText,
          cleaned_at: Date.now(),
          oneliner: out.oneliner ?? null,
        });
        // The cleaned markdown's section/bullet structure produces better-
        // shaped chunks than the raw_text fallback path. Re-chunk + rescore
        // so the chip reflects the improved signal.
        await rechunkAndEmbed(id, next);
        await computeAndPersistMatch(id);
        const refreshed = await getJob(id);
        sendResponse({
          ok: true,
          cleaned: true,
          latencyMs: out.latencyMs,
          job: refreshed,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  return false;
});
