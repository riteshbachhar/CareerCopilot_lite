import {
  addJob,
  findJobByUrl,
  putEmbedding,
  getEmbedding,
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
  getProfileVersion,
  setProfileVersion,
  clearProfileVersion,
} from './db.js';
import { extractJobPostingFromPage } from './adapters/json-ld.js';
import { parseProfileMarkdown } from './profile/parse-markdown.js';
import { computeMatch } from './match.js';
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

// Build the text that actually gets embedded. Title / company / location
// are part of the JD's semantic identity, so include them as a header
// line followed by the body. Keeps the stored raw_text clean while the
// vector reflects the full role context.
function buildEmbedText({ title, company, location, raw_text }) {
  const header = [title, company, location].filter(Boolean).join(' · ');
  return [header, raw_text].filter(Boolean).join('\n\n');
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
// and ingest-resume (LLM-extracted facts). Wipes the profile, embeds every
// fact, stores it, pings progress per fact, then bumps profile_version and
// fires match-stale so the side panel can mark existing matches as stale.
async function ingestFactList(facts) {
  await clearProfile();
  const total = facts.length;
  let done = 0;
  for (const fact of facts) {
    const breadcrumb = [fact.section, fact.subsection].filter(Boolean).join(' › ');
    const embedInput = [breadcrumb, fact.text].filter(Boolean).join('\n');
    const { vector, dims, modelId, modelVersion } = await embedViaOffscreen(embedInput);
    const row = await addProfileFact({
      section: fact.section,
      subsection: fact.subsection,
      text: fact.text,
      order: fact.order,
      model_id: modelId,
      model_version: modelVersion,
    });
    await putProfileEmbedding({ fact_id: row.id, vector, dims });
    done += 1;
    chrome.runtime
      .sendMessage({ target: 'sidepanel', type: 'ingest-progress', done, total })
      .catch(() => {});
  }
  const newVersion = String(Date.now());
  await setProfileVersion(newVersion);
  chrome.runtime
    .sendMessage({ target: 'sidepanel', type: 'match-stale', profile_version: newVersion })
    .catch(() => {});
  return { count: done, profile_version: newVersion };
}

// Compute and persist a match score for a JD. Reads the existing JD vector
// (cheap) instead of re-embedding. No-op when no profile is ingested.
async function computeAndPersistMatch(jdId, jdVector) {
  const profileVersion = await getProfileVersion();
  if (!profileVersion) return null;
  const vec =
    jdVector ??
    (await getEmbedding(jdId))?.vector ??
    null;
  if (!vec) return null;
  const { score, top_facts } = await computeMatch(vec);
  await updateJob(jdId, {
    match_score: score,
    match_facts: top_facts,
    match_computed_at: Date.now(),
    match_profile_version: profileVersion,
  });
  return { score, top_facts, profile_version: profileVersion };
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

  const embedInput = buildEmbedText({
    title,
    company,
    location,
    raw_text: text,
  });
  const { vector, dims, modelId, modelVersion, coldStartMs, embedMs } =
    await embedViaOffscreen(embedInput);

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
  await putEmbedding({ jd_id: row.id, vector, dims });
  await computeAndPersistMatch(row.id, vector);

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
        const profileVersion = await getProfileVersion();
        const slim = jobs.map(({ raw_text, oneliner, match_facts, ...rest }) => ({
          ...rest,
          // Prefer the LLM oneliner from cleanup; fall back to a raw_text
          // snippet for rows that haven't been cleaned yet.
          preview:
            (typeof oneliner === 'string' && oneliner.trim()) ||
            raw_text.slice(0, 200),
        }));
        sendResponse({ ok: true, jobs: slim, profile_version: profileVersion });
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
        const profileVersion = await getProfileVersion();
        let hydrated_match_facts = null;
        if (row?.match_facts?.length) {
          hydrated_match_facts = await Promise.all(
            row.match_facts.map(async (f) => {
              const fact = await getProfileFact(f.fact_id);
              return {
                fact_id: f.fact_id,
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
          profile_version: profileVersion,
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

        let vector = null;
        if (embedDirty) {
          const embedInput = buildEmbedText({
            title: nextTitle,
            company: nextCompany,
            location: nextLocation,
            raw_text: nextRawText,
          });
          const out = await embedViaOffscreen(embedInput);
          vector = out.vector;
          await putEmbedding({ jd_id: id, vector, dims: out.dims });
          changes.model_id = out.modelId;
          changes.model_version = out.modelVersion;
        }

        const next = await updateJob(id, changes);
        if (embedDirty) await computeAndPersistMatch(id, vector);
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
        const markdown = String(msg.markdown ?? '');
        const facts = parseProfileMarkdown(markdown);
        if (facts.length === 0) throw new Error('no facts parsed from markdown');
        const result = await ingestFactList(facts);
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
        const result = await ingestFactList(factsWithOrder);
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
        const count = await countProfileFacts();
        const profileVersion = await getProfileVersion();
        sendResponse({ ok: true, count, profile_version: profileVersion });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  if (msg.type === 'list-profile-facts') {
    (async () => {
      try {
        const facts = await listProfileFacts();
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
        await clearProfile();
        await clearProfileVersion();
        chrome.runtime
          .sendMessage({
            target: 'sidepanel',
            type: 'match-stale',
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

  if (msg.type === 'recompute-match') {
    (async () => {
      try {
        const { id } = msg;
        const row = await getJob(id);
        if (!row) throw new Error(`job not found: ${id}`);
        const result = await computeAndPersistMatch(id);
        if (!result) {
          sendResponse({ ok: true, score: null, profile_version: null });
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
        const profileVersion = await getProfileVersion();
        if (!profileVersion) {
          sendResponse({ ok: true, updated: 0, profile_version: null });
          return;
        }
        const jobs = await listJobs();
        const stale = jobs.filter(
          (j) => j.match_profile_version !== profileVersion,
        );
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
        sendResponse({
          ok: true,
          updated: done,
          total: stale.length,
          profile_version: profileVersion,
        });
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
        sendResponse({
          ok: true,
          cleaned: true,
          latencyMs: out.latencyMs,
          job: next,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();
    return true;
  }

  return false;
});
