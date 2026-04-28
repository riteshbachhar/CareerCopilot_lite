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
    // Compute DOM-text first. We need it both as the final fallback and
    // as a yardstick to detect Readability cropping (see below). Capture
    // preserves; the optional LLM cleanup step is the layer that filters
    // chrome — so no boilerplate-heading trim here. Anchored
    // CTA/cookie-line filter only.
    const mainEl =
      document.querySelector(
        'main, article, [role="main"], #main, #content, .job__description',
      ) ?? document.body;
    const domClone = mainEl.cloneNode(true);
    domClone
      .querySelectorAll(
        'script, style, nav, header, footer, aside, form, [role="navigation"], [role="banner"], [role="contentinfo"]',
      )
      .forEach((el) => el.remove());

    let domText = (domClone.textContent ?? '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    const CTA_PATTERNS = [
      /^apply\s+(now|for\s+this\s+(job|position|role))\b/i,
      /^submit\s+your\s+application\b/i,
      /^we\s+use\s+cookies\b/i,
      /^accept\s+(all\s+)?cookies\b/i,
    ];
    domText = domText
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (!t) return true;
        return !CTA_PATTERNS.some((re) => re.test(t));
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Try Readability. It scores DOM subtrees and returns the highest one,
    // with cleaner article metadata (title, siteName) than DOM-text. But
    // it picks a *single* subtree, so on SPAs that split content across
    // sibling components (e.g. Interfolio's Angular layout) it can
    // silently crop half the JD. Accept its output only when it's
    // competitive with DOM-text length — a big gap signals cropping.
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
        if (
          readableText.length >= 200 &&
          readableText.length >= domText.length * 0.8
        ) {
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
        // Fall through to DOM-text.
      }
    }

    if (domText.length < 200) {
      return {
        ok: false,
        error: `no JobPosting schema + DOM text too short (${domText.length} chars) — try pasting the JD`,
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
        description: domText,
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
