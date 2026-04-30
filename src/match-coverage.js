import { profileCosineSearchBatch } from './db.js';

// Asymmetric JD-coverage match score.
//
// Given a list of JD chunks (each with its own embedding), find the best
// matching profile fact for each chunk and average those per-chunk best
// cosines, weighted by the chunk's section. This answers "does my profile
// cover the JD's requirements?" rather than the symmetric "what are my
// closest profile sentences to the JD-as-a-bag?" that the simple top-K-mean
// baseline answers, and biases toward must-have sections over nice-to-have.
//
// Score is bounded [0, 1] (weighted mean of values in [0, 1] with positive
// weights). Empty profile or empty chunks → 0.
//
// Sections come from chunkJD: cleaned-markdown headings yield a section
// string; raw-text fallbacks yield null. Null / unknown sections get the
// neutral 1.0 weight, so this stays a no-op for rows without cleaned text.
//
// `search` is injected so unit tests can stub the data layer.

// Order matters: nice-to-have is checked first so "preferred qualifications"
// resolves to 0.75 (nice-to-have) rather than 1.25 (qualifications match).
const SECTION_WEIGHT_RULES = [
  { weight: 0.75, re: /\b(nice[- ]to[- ]have|preferred|bonus|good to have|extra|plus)\b/i },
  {
    weight: 1.25,
    re: /\b(requirements?|qualifications?|must[- ]have|required|what you'?ll need|what you bring|skills required)\b/i,
  },
];

export function sectionWeight(section) {
  if (!section || typeof section !== 'string') return 1.0;
  for (const { weight, re } of SECTION_WEIGHT_RULES) {
    if (re.test(section)) return weight;
  }
  return 1.0;
}

export async function computeMatchCoverage(
  chunkVectors,
  { profileId, search = profileCosineSearchBatch } = {},
) {
  if (!profileId) throw new Error('computeMatchCoverage: profileId required');
  if (!Array.isArray(chunkVectors) || chunkVectors.length === 0) {
    return { score: 0, top_facts: [] };
  }
  const queries = chunkVectors.map((c) => c.vector);
  const results = await search(queries, { profileId, topKPerQuery: 1 });
  const top_facts = chunkVectors.map((c, i) => {
    const top = results[i]?.[0];
    const weight = sectionWeight(c.section);
    return {
      chunk_index: c.chunk_index,
      chunk_text: c.chunk_text,
      weight,
      fact_id: top?.fact_id ?? null,
      score: top?.score ?? 0,
    };
  });
  const totalWeight = top_facts.reduce((s, f) => s + f.weight, 0);
  const score =
    totalWeight > 0
      ? top_facts.reduce((s, f) => s + f.weight * f.score, 0) / totalWeight
      : 0;
  return { score, top_facts };
}
