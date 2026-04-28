import {
  JOB_STATUSES,
  DEFAULT_STATUS,
  SORT_MODES,
  DEFAULT_SORT,
  STATUS_ORDER,
} from './constants.js';

const $ = (id) => document.getElementById(id);

// ---------- DOM refs ----------

// Toolbar
const backBtn = $('back-btn');
const toolbarTitle = $('toolbar-title');
const openProfileBtn = $('open-profile');
const openSettingsBtn = $('open-settings');

// Library view
const libraryView = $('library-view');
const captureTabBtn = $('capture-tab');
const captureTabStatus = $('capture-tab-status');
const paste = $('paste');
const captureBtn = $('capture');
const captureStatus = $('capture-status');
const filterInput = $('filter');
const statusFilter = $('status-filter');
const sortMode = $('sort-mode');
const pipelineStrip = $('pipeline-strip');
const jobsEl = $('jobs');
const recomputeBanner = $('recompute-banner');
const recomputeBannerLabel = $('recompute-banner-label');
const recomputeAllBtn = $('recompute-all-btn');

// Detail view
const detailView = $('detail-view');
const detailContent = $('detail-content');

// Profile drawer
const profileBackdrop = $('profile-backdrop');
const profileDrawer = $('profile-drawer');
const closeProfileBtn = $('close-profile');
const profileSummary = $('profile-summary');
const profileFile = $('profile-file');
const profilePaste = $('profile-paste');
const ingestProfileBtn = $('ingest-profile');
const clearProfileBtn = $('clear-profile');
const profileStatus = $('profile-status');
const ingestProgress = $('ingest-progress');
const ingestProgressFill = $('ingest-progress-fill');
const profileFactsDetails = $('profile-facts-details');
const profileMetrics = $('profile-metrics');
const profileFactsList = $('profile-facts-list');
const resumeFile = $('resume-file');
const resumeUploadBtn = $('resume-upload-btn');
const exportCsvBtn = $('export-csv');
const exportJsonBtn = $('export-json');
const exportRedact = $('export-redact');
const exportStatus = $('export-status');

// Settings drawer
const settingsBackdrop = $('settings-backdrop');
const settingsDrawer = $('settings-drawer');
const closeSettingsBtn = $('close-settings');
const settingsApiKey = $('settings-api-key');
const settingsKeyStatus = $('settings-key-status');
const settingsModel = $('settings-model');
const settingsEnabled = $('settings-enabled');
const settingsSave = $('settings-save');
const settingsTest = $('settings-test');
const settingsClear = $('settings-clear');
const settingsStatus = $('settings-status');

// ---------- State ----------

let currentView = 'library';
let currentJobId = null;
let currentJobFull = null;
let currentJobMatchFacts = null;
let isEditMode = false;
let cachedJobs = [];
let currentProfileVersion = null;
// Cached so we can show/hide the "Clean up JD" button without asking the
// background on every detail render. Refreshed on settings save.
let llmEnabledHasKey = false;
// Per-detail-view toggle for which body the user wants to read. Reset on
// every navigation to a detail view; defaults to 'cleaned' when available.
let bodyViewMode = 'cleaned';

// ---------- Helpers ----------

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'background', type, ...extra });
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(0) : '?';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Tier thresholds chosen for L2-normalized MiniLM embeddings: most random
// pairs land in 0.1–0.3, so >=0.5 is meaningful overlap and >=0.7 is a
// strong cluster.
function matchTier(score) {
  if (score == null) return 'none';
  if (score >= 0.6) return 'strong';
  if (score >= 0.45) return 'mid';
  return 'weak';
}

function isMatchFresh(job) {
  if (job.match_score == null) return false;
  if (!currentProfileVersion) return false;
  return job.match_profile_version === currentProfileVersion;
}

// Follow-up tier — same pattern as matchTier(). Drives chip color.
function followUpTier(epochMs) {
  if (epochMs == null) return null;
  const now = Date.now();
  const dayMs = 86_400_000;
  const diffDays = Math.floor((epochMs - now) / dayMs);
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays <= 3) return 'soon';
  return 'future';
}

function formatFollowUpLabel(epochMs) {
  const d = new Date(epochMs);
  const now = new Date();
  const dayMs = 86_400_000;
  const diff = Math.round((epochMs - now.getTime()) / dayMs);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 0 && diff < 7) return `in ${diff}d`;
  if (diff < 0 && diff > -14) return `${-diff}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderFollowUpChip(job) {
  const at = job.follow_up_at ?? null;
  if (at == null) return '';
  const tier = followUpTier(at);
  return `<span class="follow-up-chip" data-tier="${tier}" title="follow up ${escapeHtml(formatFollowUpLabel(at))}">📅 ${escapeHtml(formatFollowUpLabel(at))}</span>`;
}

// Convert a date input's "YYYY-MM-DD" value to an epoch ms set to local
// midnight. Returns null for empty input. Local-tz on purpose: a follow-up
// "March 5" should mean March 5 in the user's calendar, not UTC.
function parseDateInputValue(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime();
}

function formatDateInputValue(epochMs) {
  if (epochMs == null) return '';
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatRelativeTime(epochMs) {
  if (epochMs == null) return '';
  const now = Date.now();
  const diff = epochMs - now;
  const absSec = Math.abs(diff) / 1000;
  if (absSec < 60) return diff < 0 ? 'just now' : 'soon';
  const min = absSec / 60;
  if (min < 60) return diff < 0 ? `${Math.round(min)}m ago` : `in ${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return diff < 0 ? `${Math.round(hr)}h ago` : `in ${Math.round(hr)}h`;
  const day = hr / 24;
  if (day < 30) return diff < 0 ? `${Math.round(day)}d ago` : `in ${Math.round(day)}d`;
  const d = new Date(epochMs);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderStatusTimeline(job) {
  let history = Array.isArray(job.status_history) ? job.status_history : null;
  if (!history || !history.length) {
    // Lazy-display for legacy v1 rows that haven't had setStatus called yet.
    history = [{ status: job.status ?? DEFAULT_STATUS, at: job.timestamp ?? Date.now() }];
  }
  const stages = history
    .map((h, i) => {
      const arrow = i === 0 ? '' : '<span class="arrow">→</span>';
      return `${arrow}<span class="stage" data-status="${escapeHtml(h.status)}">${escapeHtml(h.status)} <span class="when">${escapeHtml(formatRelativeTime(h.at))}</span></span>`;
    })
    .join(' ');
  return `<div class="status-timeline">${stages}</div>`;
}

function formatSalaryChip(salary) {
  if (!salary) return null;
  const cur = salary.currency ?? '';
  const unit = salary.unit ? `/${String(salary.unit).toLowerCase()}` : '';
  const fmt = (n) => {
    if (n == null) return '';
    if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
    return String(n);
  };
  if (salary.min != null && salary.max != null) {
    return `${cur} ${fmt(salary.min)}–${fmt(salary.max)}${unit}`.trim();
  }
  if (salary.min != null) return `${cur} ${fmt(salary.min)}+${unit}`.trim();
  if (salary.max != null) return `${cur} up to ${fmt(salary.max)}${unit}`.trim();
  if (salary.value != null) return `${cur} ${fmt(salary.value)}${unit}`.trim();
  return null;
}

function renderFieldChips(job) {
  const sf = job.structured_fields ?? {};
  const chips = [];
  if (sf.employment_type) {
    chips.push(String(sf.employment_type).toLowerCase().replace(/_/g, ' '));
  }
  if (sf.remote) chips.push(sf.remote);
  if (sf.seniority) chips.push(sf.seniority);
  const salary = formatSalaryChip(sf.salary);
  if (salary) chips.push(salary);
  if (sf.date_posted) {
    const d = new Date(sf.date_posted);
    if (!isNaN(d)) chips.push(`posted ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  }
  if (!chips.length) return '';
  return `<div class="field-chips">${chips.map((c) => `<span class="field-chip">${escapeHtml(c)}</span>`).join('')}</div>`;
}

// Restricted to http(s) so a malformed or hostile `url` field cannot
// become a javascript: URI when used in an href.
function safeJobUrl(job) {
  if (!job.url) return null;
  let parsed;
  try {
    parsed = new URL(job.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return { href: parsed.href, host: parsed.host.replace(/^www\./, '') };
}

// Detail-view link: full text, sits under the meta line.
function renderJobUrlLink(job) {
  const u = safeJobUrl(job);
  if (!u) return '';
  return `<a class="job-url-link" href="${escapeHtml(u.href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(u.href)}">Open at ${escapeHtml(u.host)} ↗</a>`;
}

// List-row link: icon-only so it doesn't crowd the actions strip. Lives
// inside .row-actions so the row's click-to-open handler ignores it.
function renderRowUrlLink(job) {
  const u = safeJobUrl(job);
  if (!u) return '';
  return `<a class="row-url-link" href="${escapeHtml(u.href)}" target="_blank" rel="noopener noreferrer" title="open ${escapeHtml(u.host)}" aria-label="open original posting">↗</a>`;
}

// Tiny markdown renderer for cleaned JD bodies. Handles the subset the
// cleanup prompt is asked to produce: ## headings, - bullet lists, blank-line
// paragraphs. Everything is escapeHtml'd FIRST — never trust LLM output to
// be HTML-safe.
function renderCleanedMarkdown(md) {
  const safe = escapeHtml(md ?? '');
  const lines = safe.split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join(' ')}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      i += 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      const level = Math.min(h[1].length + 2, 6); // ## → h4 in our scale
      out.push(`<h${level}>${h[2]}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(`<li>${lines[i].trim().replace(/^[-*]\s+/, '')}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    para.push(trimmed);
    i += 1;
  }
  flushPara();
  return out.join('');
}

function renderJobBody(job) {
  const hasCleaned = !!(job.cleaned_text && String(job.cleaned_text).trim());
  if (!hasCleaned) {
    return `<div class="detail-body">${escapeHtml(job.raw_text ?? '')}</div>`;
  }
  const showingCleaned = bodyViewMode !== 'original';
  const cleanedAt = job.cleaned_at
    ? `cleaned ${escapeHtml(formatRelativeTime(job.cleaned_at))}`
    : '';
  const toggle = `
    <div class="body-toggle">
      <span>View:</span>
      <button class="body-toggle-btn ${showingCleaned ? 'active' : ''}" data-mode="cleaned" type="button">cleaned ✨</button>
      <button class="body-toggle-btn ${!showingCleaned ? 'active' : ''}" data-mode="original" type="button">original</button>
      <span class="body-toggle-meta">${cleanedAt}</span>
    </div>
  `;
  const bodyHtml = showingCleaned
    ? `<div class="detail-body cleaned">${renderCleanedMarkdown(job.cleaned_text)}</div>`
    : `<div class="detail-body">${escapeHtml(job.raw_text ?? '')}</div>`;
  return `${toggle}${bodyHtml}`;
}

function renderNotesBlock(job) {
  const notes = (job.notes ?? '').trim();
  if (!notes) return '';
  return `
    <div class="detail-section-label">Notes</div>
    <div class="notes-block">${escapeHtml(notes)}</div>
  `;
}

function renderMatchChip(job) {
  if (!currentProfileVersion) return '';
  if (job.match_score == null) {
    return `<span class="match-chip" data-tier="none" title="not yet computed">—</span>`;
  }
  const pct = Math.round(job.match_score * 100);
  const tier = matchTier(job.match_score);
  const stale = !isMatchFresh(job);
  const cls = stale ? 'match-chip stale' : 'match-chip';
  const title = stale
    ? 'profile updated — recompute to refresh'
    : 'match avg of top 10 facts';
  return `<span class="${cls}" data-tier="${tier}" title="${title}">${pct}%</span>`;
}

// ---------- Row / detail rendering ----------

function renderStatusPicker(job) {
  const jobId = job.id ?? job.jd_id;
  if (!jobId) return '';
  const current = job.status ?? DEFAULT_STATUS;
  const options = JOB_STATUSES
    .map((s) => `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`)
    .join('');
  return `<select class="status-picker" data-job-id="${escapeHtml(jobId)}">${options}</select>`;
}

function renderDeleteBtn(job) {
  const jobId = job.id ?? job.jd_id;
  if (!jobId) return '';
  const icon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
  return `<button class="delete-btn" data-job-id="${escapeHtml(jobId)}" title="delete this capture" aria-label="delete">${icon}</button>`;
}

function renderRowActions(job) {
  const picker = renderStatusPicker(job);
  if (!picker) return '';
  return `
    <div class="row-actions">
      ${picker}
      ${renderMatchChip(job)}
      ${renderFollowUpChip(job)}
      ${renderRowUrlLink(job)}
      ${renderDeleteBtn(job)}
    </div>
  `;
}

function renderEditForm(job) {
  const escapedId = escapeHtml(job.id);
  const followUpValue = formatDateInputValue(job.follow_up_at);
  return `
    <div class="edit-form" data-job-id="${escapedId}">
      <label>Title
        <input class="edit-title" type="text" value="${escapeHtml(job.title ?? '')}" />
      </label>
      <label>Company
        <input class="edit-company" type="text" value="${escapeHtml(job.company ?? '')}" />
      </label>
      <label>Location
        <input class="edit-location" type="text" value="${escapeHtml(job.structured_fields?.location ?? '')}" />
      </label>
      <label>Follow up on
        <input class="edit-follow-up" type="date" value="${escapeHtml(followUpValue)}" />
      </label>
      <label>Notes
        <textarea class="edit-notes" placeholder="Recruiter name, salary range, prep notes…" style="min-height: 80px; font-family: inherit;">${escapeHtml(job.notes ?? '')}</textarea>
      </label>
      <label>JD text
        <textarea class="edit-raw-text">${escapeHtml(job.raw_text ?? '')}</textarea>
      </label>
      <div class="form-actions">
        <button class="save-btn" data-job-id="${escapedId}">Save</button>
        <button class="cancel-btn" data-job-id="${escapedId}" type="button">Cancel</button>
      </div>
    </div>
  `;
}

function renderRow(job) {
  const date = job.timestamp ? new Date(job.timestamp).toLocaleString() : '';
  const seniority = job.structured_fields?.seniority;
  const source = job.structured_fields?.source;
  const location = job.structured_fields?.location;
  const tags = [seniority, location, source].filter(Boolean).join(' · ');
  const status = job.status ?? DEFAULT_STATUS;
  const jobId = job.id ?? job.jd_id ?? '';
  return `
    <div class="row" data-job-id="${escapeHtml(jobId)}" data-status="${escapeHtml(status)}">
      <div class="title">${escapeHtml(job.title ?? '(untitled)')}</div>
      <div class="meta">${escapeHtml(job.company ?? '')}${job.company ? ' · ' : ''}${escapeHtml(date)}</div>
      ${tags ? `<div class="meta">${escapeHtml(tags)}</div>` : ''}
      <div class="preview">${escapeHtml(job.preview ?? '')}</div>
      ${renderRowActions(job)}
    </div>
  `;
}

function matchesStatusFilter(job) {
  const mode = statusFilter.value;
  const s = job.status ?? DEFAULT_STATUS;
  if (mode === 'all') return true;
  if (mode === 'active') return s !== 'archived' && s !== 'rejected';
  if (mode === 'needs_follow_up') {
    return job.follow_up_at != null && s !== 'archived';
  }
  return s === mode;
}

// Comparators for the sort select. Each returns a function(a, b).
const STATUS_RANK = Object.fromEntries(STATUS_ORDER.map((s, i) => [s, i]));
function compareJobs(mode) {
  switch (mode) {
    case 'match':
      return (a, b) => (b.match_score ?? -1) - (a.match_score ?? -1);
    case 'follow_up':
      return (a, b) => {
        const av = a.follow_up_at;
        const bv = b.follow_up_at;
        if (av == null && bv == null) return b.timestamp - a.timestamp;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      };
    case 'status':
      return (a, b) => {
        const ra = STATUS_RANK[a.status ?? DEFAULT_STATUS] ?? 99;
        const rb = STATUS_RANK[b.status ?? DEFAULT_STATUS] ?? 99;
        if (ra !== rb) return ra - rb;
        return b.timestamp - a.timestamp;
      };
    case 'recent':
    default:
      return (a, b) => b.timestamp - a.timestamp;
  }
}

function renderJobsList() {
  const filter = filterInput.value.trim().toLowerCase();
  const sortFn = compareJobs(sortMode.value || DEFAULT_SORT);
  const visible = cachedJobs
    .filter((j) => {
      if (!matchesStatusFilter(j)) return false;
      if (!filter) return true;
      const hay = [
        j.title,
        j.company,
        j.preview,
        j.notes,
        j.structured_fields?.location,
        j.structured_fields?.seniority,
        j.structured_fields?.source,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(filter);
    })
    .slice()
    .sort(sortFn);

  if (!visible.length) {
    jobsEl.className = 'jobs-list empty';
    jobsEl.innerHTML = '';
    jobsEl.textContent = cachedJobs.length
      ? '(no matches for filter)'
      : '(none yet — click Capture current tab on a job page)';
    return;
  }
  jobsEl.className = 'jobs-list';
  jobsEl.innerHTML = visible.map(renderRow).join('');
}

function renderPipelineStrip() {
  if (!cachedJobs.length) {
    pipelineStrip.hidden = true;
    pipelineStrip.innerHTML = '';
    return;
  }
  const counts = new Map();
  for (const j of cachedJobs) {
    const s = j.status ?? DEFAULT_STATUS;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const active = statusFilter.value;
  // STATUS_ORDER controls which-comes-first for visual scan; only render
  // chips with non-zero counts so the strip stays compact.
  const chipsHtml = STATUS_ORDER.filter((s) => counts.has(s))
    .map((s) => {
      const cls = active === s ? 'pipeline-chip active' : 'pipeline-chip';
      return `<button class="${cls}" data-status="${s}" type="button"><span>${s}</span> <span class="count">${counts.get(s)}</span></button>`;
    })
    .join('');
  if (!chipsHtml) {
    pipelineStrip.hidden = true;
    pipelineStrip.innerHTML = '';
    return;
  }
  pipelineStrip.hidden = false;
  pipelineStrip.innerHTML = chipsHtml;
}

function refreshRecomputeBanner() {
  if (!currentProfileVersion) {
    recomputeBanner.hidden = true;
    return;
  }
  const stale = cachedJobs.filter(
    (j) => j.match_profile_version !== currentProfileVersion,
  );
  if (!stale.length) {
    recomputeBanner.hidden = true;
    return;
  }
  recomputeBanner.hidden = false;
  recomputeBannerLabel.textContent =
    `${stale.length} match score${stale.length === 1 ? '' : 's'} stale.`;
}

async function refreshJobs() {
  const resp = await send('list');
  if (!resp?.ok) {
    jobsEl.textContent = `error: ${resp?.error ?? 'unknown'}`;
    jobsEl.className = 'jobs-list status error';
    return;
  }
  cachedJobs = resp.jobs;
  currentProfileVersion = resp.profile_version ?? null;
  renderPipelineStrip();
  renderJobsList();
  refreshRecomputeBanner();
}

// ---------- Detail view ----------

function renderMatchSection() {
  const job = currentJobFull;
  if (!job) return '';

  if (!currentProfileVersion) {
    return `
      <div class="detail-section-label">Profile match</div>
      <div class="match-card">
        <div class="match-headline">
          <span class="label">Ingest your profile to see match scores.</span>
        </div>
      </div>
    `;
  }

  const fresh = isMatchFresh(job);
  const score = job.match_score;
  const pct = score == null ? '—' : `${Math.round(score * 100)}%`;
  const tier = matchTier(score);
  const staleTag = !fresh && score != null
    ? `<span class="stale-tag">stale</span>`
    : '';
  const subLabel = score == null
    ? 'not yet computed'
    : `avg of top ${(currentJobMatchFacts ?? job.match_facts ?? []).length} facts`;

  let factsHtml = '';
  const facts = fresh ? currentJobMatchFacts : null;
  if (facts && facts.length) {
    const groups = new Map();
    for (const f of facts) {
      const key = f.section ?? '(no section)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    factsHtml = [...groups.entries()]
      .map(([sectionName, list]) => {
        const items = list
          .map((f) => {
            const breadcrumb = [f.section, f.subsection].filter(Boolean).join(' › ');
            const breadcrumbHtml = f.subsection
              ? `<div class="meta" style="font-size:10px; opacity:0.55;">${escapeHtml(breadcrumb)}</div>`
              : '';
            return `
              <div class="fact">
                <span class="score">${(f.score * 100).toFixed(0)}%</span>
                <div>
                  ${breadcrumbHtml}
                  <div>${escapeHtml(f.text)}</div>
                </div>
              </div>
            `;
          })
          .join('');
        return `
          <div class="section-block">
            <div class="section-name">${escapeHtml(sectionName)}</div>
            ${items}
          </div>
        `;
      })
      .join('');
  }

  const factsBlock = factsHtml
    ? `<div class="match-facts">${factsHtml}</div>`
    : (score == null
        ? ''
        : `<div class="status">Top facts unavailable until match is recomputed.</div>`);

  return `
    <div class="detail-section-label">Profile match</div>
    <div class="match-card">
      <div class="match-headline">
        <span class="big-score" data-tier="${tier}">${pct}</span>
        <span class="label">${escapeHtml(subLabel)}</span>
        ${staleTag}
      </div>
      ${factsBlock}
      <div class="match-actions">
        <button id="recompute-match-btn">Recompute match</button>
        <span id="recompute-match-status" class="status"></span>
      </div>
    </div>
  `;
}

function renderDetail() {
  if (!currentJobFull) return;
  const job = currentJobFull;
  const company = job.company ?? '';
  const location = job.structured_fields?.location ?? '';
  const date = job.timestamp ? new Date(job.timestamp).toLocaleString() : '';
  const status = job.status ?? DEFAULT_STATUS;
  const metaLine = [company, location, date].filter(Boolean).join(' · ');

  if (isEditMode) {
    detailContent.innerHTML = `
      <div class="detail-header" data-status="${escapeHtml(status)}">
        <div class="detail-meta">${escapeHtml(metaLine)}</div>
      </div>
      ${renderEditForm(job)}
    `;
    return;
  }

  const cleanupBtn = llmEnabledHasKey
    ? `<button class="cleanup-btn" type="button" title="ask the LLM to reorganize the JD into clean sections">Clean up JD ✨</button>`
    : '';
  detailContent.innerHTML = `
    <div class="detail-header" data-status="${escapeHtml(status)}">
      <div class="detail-meta">${escapeHtml(metaLine)}</div>
      ${renderJobUrlLink(job)}
      ${renderFieldChips(job)}
      <div class="detail-actions">
        ${renderStatusPicker(job)}
        ${renderMatchChip(job)}
        ${renderFollowUpChip(job)}
        <button class="edit-detail-btn" type="button">Edit</button>
        ${cleanupBtn}
        ${renderDeleteBtn(job)}
      </div>
      ${renderStatusTimeline(job)}
    </div>
    ${renderNotesBlock(job)}
    <div class="detail-section-label">Job description</div>
    ${renderJobBody(job)}
    ${renderMatchSection()}
  `;
}

// ---------- View switching ----------

function showLibrary() {
  currentView = 'library';
  currentJobId = null;
  currentJobFull = null;
  currentJobMatchFacts = null;
  isEditMode = false;
  detailView.hidden = true;
  libraryView.hidden = false;
  backBtn.hidden = true;
  toolbarTitle.textContent = 'Career Copilot Lite';
}

async function showDetail(jobId) {
  try {
    const resp = await send('get', { id: jobId });
    if (!resp?.ok) throw new Error(resp?.error ?? 'fetch failed');
    if (!resp.job) throw new Error('job not found');
    currentJobId = jobId;
    currentJobFull = resp.job;
    currentJobMatchFacts = resp.hydrated_match_facts ?? null;
    currentProfileVersion = resp.profile_version ?? currentProfileVersion;
    currentView = 'detail';
    isEditMode = false;
    bodyViewMode = 'cleaned';
    libraryView.hidden = true;
    detailView.hidden = false;
    backBtn.hidden = false;
    toolbarTitle.textContent = resp.job.title || '(untitled)';
    renderDetail();
  } catch (err) {
    console.error('[detail] failed', err);
    alert(`Failed to load job: ${String(err?.message ?? err)}`);
  }
}

backBtn.addEventListener('click', showLibrary);

// ---------- Drawers ----------

function openProfile() {
  profileDrawer.hidden = false;
  profileBackdrop.hidden = false;
  refreshProfileSummary();
  refreshProfileFactsView();
}
function closeProfile() {
  profileDrawer.hidden = true;
  profileBackdrop.hidden = true;
}

openProfileBtn.addEventListener('click', openProfile);
closeProfileBtn.addEventListener('click', closeProfile);
profileBackdrop.addEventListener('click', closeProfile);

// ---------- Settings drawer ----------

async function refreshSettingsDrawer() {
  try {
    const resp = await send('get-llm-settings');
    if (!resp?.ok) return;
    const s = resp.settings;
    llmEnabledHasKey = !!(s.hasKey && s.enabled);
    settingsModel.value = s.model || 'llama-3.1-8b-instant';
    settingsEnabled.checked = !!s.enabled;
    if (s.hasKey) {
      settingsApiKey.value = '';
      settingsApiKey.placeholder = `••••••${s.keyTail || ''} (saved)`;
      settingsKeyStatus.textContent = `key saved (…${s.keyTail || ''})`;
      settingsKeyStatus.className = 'status';
    } else {
      settingsApiKey.placeholder = 'gsk_…';
      settingsKeyStatus.textContent = '';
    }
  } catch {
    // ignore — background may be warming up
  }
}

function openSettings() {
  settingsDrawer.hidden = false;
  settingsBackdrop.hidden = false;
  settingsStatus.textContent = '';
  settingsStatus.className = 'status';
  refreshSettingsDrawer();
}
function closeSettings() {
  settingsDrawer.hidden = true;
  settingsBackdrop.hidden = true;
}

openSettingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', closeSettings);

settingsSave.addEventListener('click', async () => {
  settingsSave.disabled = true;
  settingsStatus.className = 'status';
  settingsStatus.textContent = 'saving…';
  const patch = {
    model: settingsModel.value,
    enabled: settingsEnabled.checked,
  };
  // Only update the key when the user typed a new one — empty input means
  // "leave the saved key alone."
  const typed = settingsApiKey.value.trim();
  if (typed) patch.apiKey = typed;
  try {
    const resp = await send('set-llm-settings', { patch });
    if (!resp?.ok) throw new Error(resp?.error ?? 'save failed');
    settingsStatus.textContent = 'saved';
    settingsApiKey.value = '';
    await refreshSettingsDrawer();
    // Detail-view Re-structure button visibility may have changed.
    if (currentView === 'detail') renderDetail();
  } catch (err) {
    settingsStatus.className = 'status error';
    settingsStatus.textContent = `error: ${String(err?.message ?? err)}`;
  } finally {
    settingsSave.disabled = false;
  }
});

settingsTest.addEventListener('click', async () => {
  settingsTest.disabled = true;
  settingsStatus.className = 'status';
  settingsStatus.textContent = 'testing…';
  try {
    // If the user typed a new key but hasn't saved, save it transiently
    // first — otherwise the test would use the old key.
    const typed = settingsApiKey.value.trim();
    if (typed) {
      await send('set-llm-settings', {
        patch: { apiKey: typed, model: settingsModel.value, enabled: settingsEnabled.checked },
      });
      settingsApiKey.value = '';
      await refreshSettingsDrawer();
    }
    const resp = await send('test-llm-connection');
    if (!resp?.ok) throw new Error(resp?.error ?? 'test failed');
    const r = resp.result;
    if (r.ok) {
      settingsStatus.textContent = `ok · ${r.latencyMs}ms`;
    } else {
      settingsStatus.className = 'status error';
      settingsStatus.textContent = `failed: ${r.error}`;
    }
  } catch (err) {
    settingsStatus.className = 'status error';
    settingsStatus.textContent = `error: ${String(err?.message ?? err)}`;
  } finally {
    settingsTest.disabled = false;
  }
});

settingsClear.addEventListener('click', async () => {
  if (!confirm('Clear LLM settings and API key? This cannot be undone.')) return;
  settingsClear.disabled = true;
  try {
    const resp = await send('clear-llm-settings');
    if (!resp?.ok) throw new Error(resp?.error ?? 'clear failed');
    settingsStatus.className = 'status';
    settingsStatus.textContent = 'cleared';
    await refreshSettingsDrawer();
    if (currentView === 'detail') renderDetail();
  } catch (err) {
    settingsStatus.className = 'status error';
    settingsStatus.textContent = `error: ${String(err?.message ?? err)}`;
  } finally {
    settingsClear.disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!profileDrawer.hidden) return closeProfile();
  if (!settingsDrawer.hidden) return closeSettings();
});

// ---------- Shared row actions (status picker + delete) ----------

async function handleStatusPickerChange(event) {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  if (!select.classList.contains('status-picker')) return;
  const jobId = select.dataset.jobId;
  const status = select.value;
  select.disabled = true;
  try {
    const resp = await send('set-status', { id: jobId, status });
    if (!resp?.ok) throw new Error(resp?.error ?? 'set-status failed');
    const row = cachedJobs.find((j) => j.id === jobId);
    if (row) row.status = status;
    if (currentView === 'detail' && currentJobId === jobId && currentJobFull) {
      currentJobFull.status = status;
      renderDetail();
    } else {
      renderJobsList();
    }
  } catch (err) {
    console.error('[status] failed to update', err);
  } finally {
    select.disabled = false;
  }
}

async function handleDeleteClick(event) {
  const btn = event.target.closest('.delete-btn');
  if (!btn) return;
  const jobId = btn.dataset.jobId;
  if (!confirm('Delete this capture? This cannot be undone.')) return;
  btn.disabled = true;
  try {
    const resp = await send('delete', { id: jobId });
    if (!resp?.ok) throw new Error(resp?.error ?? 'delete failed');
    cachedJobs = cachedJobs.filter((j) => j.id !== jobId);
    if (currentView === 'detail' && currentJobId === jobId) {
      showLibrary();
    }
    renderJobsList();
    refreshRecomputeBanner();
  } catch (err) {
    console.error('[delete] failed', err);
    btn.disabled = false;
  }
}

// ---------- Library click delegation ----------

jobsEl.addEventListener('change', handleStatusPickerChange);
jobsEl.addEventListener('click', (event) => {
  const t = event.target;
  if (t.closest('.delete-btn')) return handleDeleteClick(event);
  if (t.closest('.row-actions')) return;
  const row = t.closest('.row[data-job-id]');
  if (row) showDetail(row.dataset.jobId);
});

filterInput.addEventListener('input', renderJobsList);
statusFilter.addEventListener('change', () => {
  renderJobsList();
  renderPipelineStrip();
});
sortMode.addEventListener('change', renderJobsList);

pipelineStrip.addEventListener('click', (event) => {
  const chip = event.target.closest('.pipeline-chip');
  if (!chip) return;
  statusFilter.value = chip.dataset.status;
  renderJobsList();
  renderPipelineStrip();
});

// ---------- Detail click delegation ----------

detailContent.addEventListener('change', handleStatusPickerChange);
detailContent.addEventListener('click', (event) => {
  const t = event.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.closest('.delete-btn')) return handleDeleteClick(event);
  if (t.classList.contains('edit-detail-btn')) return handleEditClick();
  if (t.classList.contains('save-btn')) return handleSaveClick(event);
  if (t.classList.contains('cancel-btn')) return handleCancelClick();
  if (t.classList.contains('cleanup-btn')) return handleCleanupClick();
  if (t.classList.contains('body-toggle-btn')) return handleBodyToggleClick(t);
  if (t.id === 'recompute-match-btn') return handleRecomputeMatchClick();
});

function handleBodyToggleClick(btn) {
  const mode = btn.dataset.mode;
  if (!mode) return;
  bodyViewMode = mode;
  renderDetail();
}

async function handleCleanupClick() {
  if (!currentJobId) return;
  const btn = detailContent.querySelector('.cleanup-btn');
  if (!btn) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'cleaning…';
  try {
    const resp = await send('cleanup-job', { id: currentJobId });
    if (!resp?.ok) throw new Error(resp?.error ?? 'cleanup failed');
    if (!resp.cleaned) {
      const reason =
        resp.info?.skipped
          ? `skipped (${resp.info.skipped})`
          : resp.info?.error
          ? `error: ${resp.info.error}`
          : 'no result';
      const prevTitle = toolbarTitle.textContent;
      toolbarTitle.textContent = `cleanup ${reason}`;
      setTimeout(() => { toolbarTitle.textContent = prevTitle; }, 2400);
      return;
    }
    if (resp.job) {
      currentJobFull = resp.job;
    } else {
      const get = await send('get', { id: currentJobId });
      if (get?.ok && get.job) currentJobFull = get.job;
    }
    bodyViewMode = 'cleaned';
    renderDetail();
    const prevTitle = toolbarTitle.textContent;
    toolbarTitle.textContent = `cleaned · ${resp.latencyMs ?? '?'}ms`;
    setTimeout(() => { toolbarTitle.textContent = prevTitle; }, 2200);
  } catch (err) {
    console.error('[cleanup] failed', err);
    alert(`Clean up failed: ${String(err?.message ?? err)}`);
  } finally {
    const after = detailContent.querySelector('.cleanup-btn');
    if (after) {
      after.disabled = false;
      after.textContent = original;
    }
  }
}

function handleEditClick() {
  isEditMode = true;
  renderDetail();
}

function handleCancelClick() {
  isEditMode = false;
  renderDetail();
}

async function handleSaveClick(event) {
  const btn = event.target;
  if (!currentJobFull) return;
  const form = btn.closest('.edit-form');
  if (!form) return;

  const title = form.querySelector('.edit-title').value.trim() || null;
  const company = form.querySelector('.edit-company').value.trim() || null;
  const location = form.querySelector('.edit-location').value.trim() || null;
  const raw_text = form.querySelector('.edit-raw-text').value;
  const notes = form.querySelector('.edit-notes').value.trim() || null;
  const follow_up_at = parseDateInputValue(
    form.querySelector('.edit-follow-up').value,
  );

  // Decide whether the embed-input fields changed; the background's
  // update-job handler does the same check, but doing it here lets the
  // button label reflect what's actually about to happen.
  const sf = currentJobFull.structured_fields ?? {};
  const embedDirty =
    title !== currentJobFull.title ||
    company !== currentJobFull.company ||
    location !== (sf.location ?? null) ||
    raw_text !== currentJobFull.raw_text;

  btn.disabled = true;
  const cancelBtn = form.querySelector('.cancel-btn');
  if (cancelBtn) cancelBtn.disabled = true;
  const original = btn.textContent;
  btn.textContent = embedDirty ? 'embedding…' : 'saving…';

  try {
    const resp = await send('update-job', {
      id: currentJobFull.id,
      patch: { title, company, location, raw_text, notes, follow_up_at },
    });
    if (!resp?.ok) throw new Error(resp?.error ?? 'save failed');
    const get = await send('get', { id: currentJobFull.id });
    if (get?.ok && get.job) {
      currentJobFull = get.job;
      currentJobMatchFacts = get.hydrated_match_facts ?? null;
      currentProfileVersion = get.profile_version ?? currentProfileVersion;
      toolbarTitle.textContent = get.job.title || '(untitled)';
    }
    isEditMode = false;
    renderDetail();
    await refreshJobs();
  } catch (err) {
    console.error('[save] failed', err);
    btn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    btn.textContent = original;
    alert(`Save failed: ${String(err?.message ?? err)}`);
  }
}

async function handleRecomputeMatchClick() {
  if (!currentJobId) return;
  const btn = $('recompute-match-btn');
  const statusEl = $('recompute-match-status');
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.className = 'status';
    statusEl.textContent = 'computing…';
  }
  try {
    const resp = await send('recompute-match', { id: currentJobId });
    if (!resp?.ok) throw new Error(resp?.error ?? 'recompute failed');
    const get = await send('get', { id: currentJobId });
    if (get?.ok && get.job) {
      currentJobFull = get.job;
      currentJobMatchFacts = get.hydrated_match_facts ?? null;
      currentProfileVersion = get.profile_version ?? currentProfileVersion;
    }
    renderDetail();
    await refreshJobs();
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'status error';
      statusEl.textContent = `error: ${String(err?.message ?? err)}`;
    }
    if (btn) btn.disabled = false;
  }
}

// ---------- Capture ----------

async function handleCapture(type, extraArgs, btn, status) {
  btn.disabled = true;
  status.className = 'status';
  status.textContent = type === 'capture-tab' ? 'reading tab…' : 'embedding…';
  const t0 = performance.now();
  try {
    const resp = await send(type, extraArgs);
    const totalMs = performance.now() - t0;
    if (!resp?.ok) throw new Error(resp?.error ?? 'unknown');
    if (resp.deduped) {
      const titleNote = resp.title ? ` · ${resp.title}` : '';
      status.textContent = `already captured${titleNote} — opening existing row…`;
      if (type === 'capture') paste.value = '';
      await refreshJobs();
      if (resp.id) showDetail(resp.id);
      return;
    }
    const coldNote = resp.coldStartMs ? ` · cold-start ${fmt(resp.coldStartMs)}ms` : '';
    const titleNote = resp.title ? ` · ${resp.title}` : '';
    status.textContent = `captured${titleNote} · embed ${fmt(resp.embedMs)}ms · total ${fmt(totalMs)}ms${coldNote}`;
    if (type === 'capture') paste.value = '';
    await refreshJobs();
  } catch (err) {
    status.className = 'status error';
    status.textContent = `error: ${String(err?.message ?? err)}`;
  } finally {
    btn.disabled = false;
  }
}

captureBtn.addEventListener('click', () => {
  const text = paste.value.trim();
  if (!text) {
    captureStatus.textContent = 'paste something first';
    captureStatus.className = 'status error';
    return;
  }
  handleCapture('capture', { text }, captureBtn, captureStatus);
});

captureTabBtn.addEventListener('click', () => {
  handleCapture('capture-tab', {}, captureTabBtn, captureTabStatus);
});

// ---------- Recompute all matches ----------

recomputeAllBtn.addEventListener('click', async () => {
  recomputeAllBtn.disabled = true;
  const original = recomputeAllBtn.textContent;
  recomputeAllBtn.textContent = 'computing…';
  try {
    const resp = await send('recompute-all-matches');
    if (!resp?.ok) throw new Error(resp?.error ?? 'recompute failed');
    if (resp.profile_version) currentProfileVersion = resp.profile_version;
    await refreshJobs();
  } catch (err) {
    console.error('[recompute-all] failed', err);
  } finally {
    recomputeAllBtn.textContent = original;
    recomputeAllBtn.disabled = false;
  }
});

// ---------- Profile drawer ----------

function setProgress(done, total) {
  if (total <= 0) {
    ingestProgress.hidden = true;
    ingestProgressFill.style.width = '0%';
    return;
  }
  ingestProgress.hidden = false;
  ingestProgressFill.style.width = `${Math.min(100, (done / total) * 100)}%`;
}

async function refreshProfileSummary() {
  try {
    const resp = await send('profile-stats');
    if (!resp?.ok) return;
    currentProfileVersion = resp.profile_version ?? null;
    if (resp.count > 0) {
      profileSummary.textContent = `${resp.count} profile fact(s) ingested`;
      openProfileBtn.classList.add('has-dot');
    } else {
      profileSummary.textContent = '(no profile yet)';
      openProfileBtn.classList.remove('has-dot');
    }
  } catch {
    // ignore — background may be warming up
  }
}

function renderProfileMetrics(facts) {
  if (!facts.length) return '';
  const counts = new Map();
  for (const f of facts) {
    const key = f.section ?? '(no section)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const breakdownHtml = sorted
    .map(([name, n]) => {
      const cls = n < 3 ? ' class="sparse" title="sparse section — retrieval risk"' : '';
      return `<span${cls}>${escapeHtml(name)}: ${n}</span>`;
    })
    .join('');
  const first = facts[0];
  const modelLine = first.model_id
    ? `<div class="model">${escapeHtml(first.model_id)} · ${escapeHtml(first.model_version ?? '?')}</div>`
    : '';
  return `
    <div class="total">${facts.length} atomic fact${facts.length === 1 ? '' : 's'} across ${sorted.length} section${sorted.length === 1 ? '' : 's'}</div>
    <div class="breakdown">${breakdownHtml}</div>
    ${modelLine}
  `;
}

function renderProfileFactsList(facts) {
  if (!facts.length) return '';
  const sections = new Map();
  for (const f of facts) {
    const sectionKey = f.section ?? '(no section)';
    if (!sections.has(sectionKey)) sections.set(sectionKey, new Map());
    const subKey = f.subsection ?? '__top__';
    const sub = sections.get(sectionKey);
    if (!sub.has(subKey)) sub.set(subKey, []);
    sub.get(subKey).push(f);
  }

  return [...sections.entries()]
    .map(([sectionName, subs]) => {
      const subBlocks = [...subs.entries()]
        .map(([subName, list]) => {
          const factsHtml = list
            .map((f) => `<div class="fact">${escapeHtml(f.text)}</div>`)
            .join('');
          if (subName === '__top__') return factsHtml;
          return `
            <div class="subsection-block">
              <div class="subsection-name">${escapeHtml(subName)}</div>
              ${factsHtml}
            </div>
          `;
        })
        .join('');
      return `
        <div class="section-block">
          <div class="section-name">${escapeHtml(sectionName)}</div>
          ${subBlocks}
        </div>
      `;
    })
    .join('');
}

async function refreshProfileFactsView() {
  try {
    const resp = await send('list-profile-facts');
    if (!resp?.ok) return;
    const facts = resp.facts ?? [];
    if (!facts.length) {
      profileFactsDetails.hidden = true;
      return;
    }
    profileFactsDetails.hidden = false;
    const summaryEl = profileFactsDetails.querySelector('.profile-facts-summary');
    if (summaryEl) summaryEl.textContent = `View facts (${facts.length})`;
    profileMetrics.innerHTML = renderProfileMetrics(facts);
    profileFactsList.innerHTML = renderProfileFactsList(facts);
  } catch {
    // ignore — background may be warming up
  }
}

profileFile.addEventListener('change', async () => {
  const file = profileFile.files?.[0];
  if (!file) return;
  const text = await file.text();
  profilePaste.value = text;
});

// ---------- Resume upload (PDF / plain text) ----------

resumeUploadBtn.addEventListener('click', () => resumeFile.click());

// Convert an ArrayBuffer to base64. Chunked to avoid call-stack limits on
// large files (String.fromCharCode.apply has a per-call argument cap).
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

resumeFile.addEventListener('change', async () => {
  const file = resumeFile.files?.[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  resumeUploadBtn.disabled = true;
  clearProfileBtn.disabled = true;
  profileStatus.className = 'status';
  setProgress(0, 1);

  const t0 = performance.now();
  try {
    let resp;
    if (name.endsWith('.pdf')) {
      profileStatus.textContent = 'reading PDF…';
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      resp = await send('ingest-resume', {
        kind: 'pdf',
        base64,
        filename: file.name,
      });
    } else if (name.endsWith('.txt') || file.type === 'text/plain') {
      profileStatus.textContent = 'reading text…';
      const text = await file.text();
      resp = await send('ingest-resume', { kind: 'text', text });
    } else {
      throw new Error(`Unsupported file type: ${file.name}. Use .pdf or .txt (or paste markdown under Advanced).`);
    }
    if (!resp?.ok) throw new Error(resp?.error ?? 'ingest failed');
    const totalMs = performance.now() - t0;
    profileStatus.textContent = `ingested ${resp.count} fact(s) · ${fmt(totalMs)}ms total${resp.dropped ? ` · ${resp.dropped} malformed dropped` : ''}`;
    await refreshProfileSummary();
    await refreshProfileFactsView();
    await refreshJobs();
  } catch (err) {
    profileStatus.className = 'status error';
    profileStatus.textContent = `error: ${String(err?.message ?? err)}`;
  } finally {
    resumeUploadBtn.disabled = false;
    clearProfileBtn.disabled = false;
    resumeFile.value = '';
    setTimeout(() => setProgress(0, 0), 1200);
  }
});

ingestProfileBtn.addEventListener('click', async () => {
  const md = profilePaste.value.trim();
  if (!md) {
    profileStatus.className = 'status error';
    profileStatus.textContent = 'paste or upload a markdown file first';
    return;
  }
  ingestProfileBtn.disabled = true;
  clearProfileBtn.disabled = true;
  profileStatus.className = 'status';
  profileStatus.textContent = 'parsing…';
  setProgress(0, 1);
  const t0 = performance.now();
  try {
    const resp = await send('ingest-profile', { markdown: md });
    if (!resp?.ok) throw new Error(resp?.error ?? 'ingest failed');
    const totalMs = performance.now() - t0;
    profileStatus.textContent =
      `ingested ${resp.count} fact(s) · ${fmt(totalMs)}ms total`;
    profilePaste.value = '';
    profileFile.value = '';
    await refreshProfileSummary();
    await refreshProfileFactsView();
    await refreshJobs();
  } catch (err) {
    profileStatus.className = 'status error';
    profileStatus.textContent = `error: ${String(err?.message ?? err)}`;
  } finally {
    ingestProfileBtn.disabled = false;
    clearProfileBtn.disabled = false;
    setTimeout(() => setProgress(0, 0), 1200);
  }
});

clearProfileBtn.addEventListener('click', async () => {
  if (!confirm('Clear all profile facts? This cannot be undone.')) return;
  clearProfileBtn.disabled = true;
  try {
    const resp = await send('clear-profile');
    if (!resp?.ok) throw new Error(resp?.error ?? 'clear failed');
    profileStatus.className = 'status';
    profileStatus.textContent = 'cleared';
    await refreshProfileSummary();
    await refreshProfileFactsView();
    await refreshJobs();
  } catch (err) {
    profileStatus.className = 'status error';
    profileStatus.textContent = `error: ${String(err?.message ?? err)}`;
  } finally {
    clearProfileBtn.disabled = false;
  }
});

// ---------- Export ----------

function exportFilename(format) {
  const stamp = new Date().toISOString().slice(0, 10);
  return `careerpilot-jobs-${stamp}.${format}`;
}

function jobToExportRow(job, redact) {
  const sf = job.structured_fields ?? {};
  const followUp = job.follow_up_at
    ? new Date(job.follow_up_at).toISOString().slice(0, 10)
    : '';
  return {
    id: job.id,
    title: job.title ?? '',
    company: job.company ?? '',
    url: job.url ?? '',
    status: job.status ?? '',
    captured_at: job.timestamp ? new Date(job.timestamp).toISOString() : '',
    follow_up_at: followUp,
    location: sf.location ?? '',
    seniority: sf.seniority ?? '',
    employment_type: sf.employment_type ?? '',
    remote: sf.remote ?? '',
    salary: formatSalaryChip(sf.salary) ?? '',
    date_posted: sf.date_posted ?? '',
    source: sf.source ?? '',
    match_score: job.match_score ?? '',
    match_profile_version: job.match_profile_version ?? '',
    notes: redact ? '' : (job.notes ?? ''),
    raw_text: redact ? '' : (job.preview ?? ''),
    status_history: Array.isArray(job.status_history)
      ? job.status_history.map((h) => `${h.status}@${new Date(h.at).toISOString()}`).join(' › ')
      : '',
  };
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleExport(format) {
  exportStatus.className = 'status';
  exportStatus.textContent = 'gathering…';
  try {
    // refreshJobs() already populated cachedJobs; reuse so we don't bother
    // the background. Note: cachedJobs holds preview, not raw_text — for
    // plain export that's the right tradeoff (preview avoids dumping
    // 50KB JD bodies into a CSV by accident).
    if (!cachedJobs.length) {
      exportStatus.textContent = 'nothing to export';
      return;
    }
    const redact = !!exportRedact.checked;
    const rows = cachedJobs.map((j) => jobToExportRow(j, redact));
    let blob;
    if (format === 'csv') {
      blob = new Blob([rowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
    } else {
      blob = new Blob([JSON.stringify(rows, null, 2)], {
        type: 'application/json',
      });
    }
    downloadBlob(blob, exportFilename(format));
    exportStatus.textContent = `exported ${rows.length} row(s)`;
  } catch (err) {
    exportStatus.className = 'status error';
    exportStatus.textContent = `error: ${String(err?.message ?? err)}`;
  }
}

exportCsvBtn.addEventListener('click', () => handleExport('csv'));
exportJsonBtn.addEventListener('click', () => handleExport('json'));

// ---------- Init: sort dropdown ----------

function populateSortDropdown() {
  sortMode.innerHTML = SORT_MODES
    .map((m) => `<option value="${m.value}">${m.label}</option>`)
    .join('');
  sortMode.value = DEFAULT_SORT;
}

// Background pings for long-running ingest + match-stale notifications.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'sidepanel') return false;
  if (msg.type === 'ingest-stage') {
    profileStatus.className = 'status';
    profileStatus.textContent = msg.stage;
  } else if (msg.type === 'ingest-progress') {
    profileStatus.className = 'status';
    profileStatus.textContent = `embedding ${msg.done} / ${msg.total}…`;
    setProgress(msg.done, msg.total);
  } else if (msg.type === 'match-stale') {
    currentProfileVersion = msg.profile_version ?? null;
    refreshJobs();
  } else if (msg.type === 'recompute-progress') {
    // Optional: surface in the recompute banner. For now, just leave it
    // silent — the final refreshJobs() after the call resolves updates UI.
  }
  return false;
});

// ---------- Init ----------

populateSortDropdown();
refreshProfileSummary();
refreshSettingsDrawer();
refreshJobs();
