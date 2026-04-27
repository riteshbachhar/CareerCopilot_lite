// Generic JobPosting extractor. Runs in the target page's context via
// chrome.scripting.executeScript, so the function body must be
// self-contained (no imports, no closure refs to surrounding module).
//
// Covers every site that emits schema.org JobPosting JSON-LD: Greenhouse
// (raw + fronted), Lever, Ashby, Workable, and most company career pages
// built on those ATSes. Falls back to DOM-text on sites that skip JSON-LD.
//
// Async because of the SPA retry pass: on first miss we wait briefly for
// hydration before falling back. executeScript awaits the returned Promise.

export async function extractJobPostingFromPage() {
  const findCandidates = () => {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    );
    const out = [];
    const typeMatches = (t) => {
      if (!t) return false;
      if (Array.isArray(t)) return t.some(typeMatches);
      return /JobPosting/i.test(String(t));
    };
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeMatches(node['@type'])) out.push(node);
      if (node['@graph']) visit(node['@graph']);
      if (node.itemListElement) visit(node.itemListElement);
      if (node.mainEntity) visit(node.mainEntity);
      if (node.item) visit(node.item);
    };
    for (const s of scripts) {
      let data;
      try {
        data = JSON.parse(s.textContent ?? '');
      } catch {
        continue;
      }
      visit(data);
    }
    return out;
  };

  const bodyTextLength = () => (document.body?.textContent ?? '').length;

  // First pass.
  let candidates = findCandidates();

  // SPA retry: if no JSON-LD AND body text is thin, wait briefly for
  // hydration. Resolves early on either signal; capped at 400ms so a
  // truly-empty page still fails fast.
  if (!candidates.length && bodyTextLength() < 500) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (
              node.nodeType === 1 &&
              node.matches?.('script[type="application/ld+json"]')
            ) {
              return finish();
            }
          }
        }
        if (bodyTextLength() >= 500) finish();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      const timer = setTimeout(finish, 400);
    });
    candidates = findCandidates();
  }

  if (!candidates.length) {
    // Readability fallback — runs before the naive DOM strip when
    // available. Mozilla's reader-view algorithm handles modern career
    // SPAs (heavy chrome, multi-column layouts, hidden boilerplate) far
    // better than CSS-selector heuristics. Loaded into globalThis by
    // readability.js, which background.js injects before this extractor.
    if (typeof globalThis.Readability === 'function') {
      try {
        // Readability mutates the document it parses, so clone first.
        const docClone = document.cloneNode(true);
        const article = new globalThis.Readability(docClone).parse();
        const readableText = (article?.textContent ?? '')
          .replace(/\s+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]+/g, ' ')
          .trim();
        if (readableText.length >= 200) {
          return {
            ok: true,
            jd: {
              url: location.href,
              title:
                article.title ||
                document.querySelector('h1')?.textContent?.trim() ||
                document.title ||
                null,
              company: article.siteName ?? null,
              location: null,
              description: readableText,
              source: 'readability',
              structured_fields: null,
            },
          };
        }
      } catch {
        // Fall through to the naive DOM strip below.
      }
    }

    // Final fallback: hand-rolled DOM text extraction. Used when
    // Readability is unavailable (injection skipped) or its output is
    // too short to be a real JD.
    const mainEl =
      document.querySelector(
        'main, article, [role="main"], #main, #content, .job__description',
      ) ?? document.body;
    const clone = mainEl.cloneNode(true);
    clone
      .querySelectorAll(
        'script, style, nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"]',
      )
      .forEach((el) => el.remove());

    // Boilerplate trim: drop heading + following siblings (until the next
    // same-or-higher heading) when the heading text matches a known
    // boilerplate section. Anchored patterns only — false positives here
    // silently delete real JD content.
    const BOILERPLATE_HEADINGS = [
      /equal\s+opportunity|^EEO\b|diversity\s+(and|&)\s+inclusion|affirmative\s+action/i,
      /^benefits$|what\s+we\s+offer|^perks(\s+and\s+benefits)?$|^compensation(\s+range)?$|pay\s+(range|transparency)/i,
      /^about\s+(us|the\s+company|the\s+team)$|^who\s+we\s+are$|^our\s+(mission|story|values|culture)$/i,
      /^how\s+to\s+apply$|application\s+(instructions|process)|^next\s+steps$/i,
    ];
    const isBoilerplateHeading = (el) => {
      const txt = (el.textContent ?? '').trim();
      if (txt.length < 3 || txt.length > 80) return false;
      return BOILERPLATE_HEADINGS.some((re) => re.test(txt));
    };
    const headings = Array.from(clone.querySelectorAll('h1, h2, h3, h4'));
    for (const h of headings) {
      if (!h.isConnected) continue;
      if (!isBoilerplateHeading(h)) continue;
      const level = parseInt(h.tagName[1], 10);
      let node = h;
      const toRemove = [];
      while (node) {
        toRemove.push(node);
        const next = node.nextElementSibling;
        if (next && /^H[1-4]$/.test(next.tagName)) {
          const nextLevel = parseInt(next.tagName[1], 10);
          if (nextLevel <= level) break;
        }
        node = node.nextElementSibling;
      }
      toRemove.forEach((n) => n.remove());
    }

    let description = (clone.textContent ?? '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    // Strip standalone CTA / cookie lines that survive the heading pass.
    const CTA_PATTERNS = [
      /^apply\s+(now|for\s+this\s+(job|position|role))\b/i,
      /^submit\s+your\s+application\b/i,
      /^we\s+use\s+cookies\b/i,
      /^accept\s+(all\s+)?cookies\b/i,
    ];
    description = description
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (!t) return true;
        return !CTA_PATTERNS.some((re) => re.test(t));
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (description.length < 200) {
      return {
        ok: false,
        error: `no JobPosting schema + DOM text too short (${description.length} chars) — try pasting the JD`,
      };
    }

    const title =
      document.querySelector('h1')?.textContent?.trim() ||
      document.title ||
      null;

    return {
      ok: true,
      jd: {
        url: location.href,
        title,
        company: null,
        location: null,
        description,
        source: 'dom-text',
        structured_fields: null,
      },
    };
  }

  const jp = candidates[0];

  const formatLocation = (l) => {
    const arr = Array.isArray(l) ? l : l ? [l] : [];
    return (
      arr
        .map((x) => {
          const addr = x?.address;
          if (!addr) return null;
          return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
            .filter(Boolean)
            .join(', ');
        })
        .filter(Boolean)
        .join(' / ') || null
    );
  };

  const stripHtml = (html) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = html ?? '';
    return (tmp.textContent ?? '').replace(/\s+\n/g, '\n').trim();
  };

  const description = stripHtml(jp.description ?? '');
  if (description.length < 40) {
    return { ok: false, error: 'JobPosting description too short' };
  }

  // baseSalary may be a Number, a MonetaryAmount, or an array of those.
  const formatSalary = (s) => {
    if (s == null) return null;
    if (Array.isArray(s)) {
      for (const v of s) {
        const out = formatSalary(v);
        if (out) return out;
      }
      return null;
    }
    if (typeof s === 'number') return { value: s };
    const currency = s.currency ?? s.currencyCode ?? null;
    const v = s.value;
    if (v == null) return null;
    if (typeof v === 'number') return { currency, value: v };
    // QuantitativeValue: {minValue, maxValue, value, unitText}
    const min = v.minValue ?? null;
    const max = v.maxValue ?? null;
    const single = v.value ?? null;
    const unit = v.unitText ?? null; // HOUR | DAY | WEEK | MONTH | YEAR
    if (min == null && max == null && single == null) return null;
    return { currency, min, max, value: single, unit };
  };

  // jobLocationType: schema.org enum, currently only "TELECOMMUTE".
  const jlt = jp.jobLocationType;
  const remoteFlag = (Array.isArray(jlt) ? jlt : jlt ? [jlt] : [])
    .some((v) => /telecommute|remote/i.test(String(v)))
    ? 'remote'
    : null;

  return {
    ok: true,
    jd: {
      url: location.href,
      title: jp.title ?? null,
      company: jp.hiringOrganization?.name ?? null,
      location: formatLocation(jp.jobLocation),
      description,
      source: 'json-ld',
      structured_fields: {
        employment_type: jp.employmentType ?? null,
        date_posted: jp.datePosted ?? null,
        valid_through: jp.validThrough ?? null,
        salary: formatSalary(jp.baseSalary),
        remote: remoteFlag,
      },
    },
  };
}
