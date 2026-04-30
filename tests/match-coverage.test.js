import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeMatchCoverage, sectionWeight } from '../src/match-coverage.js';

// Build a fake search function that mimics profileCosineSearchBatch:
// returns top-K facts per query, ranked by a caller-provided score map.
// The map is keyed by chunk_index so each chunk can have its own ranking.
function makeSearch(rankingByChunkIndex) {
  return async (queryVectors, { topKPerQuery = 1 } = {}) => {
    return queryVectors.map((_, i) => {
      const ranking = rankingByChunkIndex[i] ?? [];
      return ranking.slice(0, topKPerQuery);
    });
  };
}

test('computeMatchCoverage: empty chunks returns 0/[]', async () => {
  const result = await computeMatchCoverage([], { profileId: 'p1' });
  assert.equal(result.score, 0);
  assert.deepEqual(result.top_facts, []);
});

test('computeMatchCoverage: requires profileId', async () => {
  await assert.rejects(
    computeMatchCoverage([{ chunk_index: 0, chunk_text: 'x', vector: new Float32Array([1]) }], {}),
    /profileId required/,
  );
});

test('computeMatchCoverage: per-chunk top-1 selection, mean is the per-chunk best', async () => {
  const chunks = [
    { chunk_index: 0, chunk_text: 'design distributed systems', vector: new Float32Array([1, 0]) },
    { chunk_index: 1, chunk_text: 'mentor junior engineers', vector: new Float32Array([0, 1]) },
  ];
  const search = makeSearch({
    0: [{ fact_id: 'f1', score: 0.9 }, { fact_id: 'f2', score: 0.4 }],
    1: [{ fact_id: 'f3', score: 0.5 }],
  });
  const result = await computeMatchCoverage(chunks, { profileId: 'p1', search });
  assert.equal(result.top_facts.length, 2);
  assert.equal(result.top_facts[0].fact_id, 'f1');
  assert.equal(result.top_facts[0].score, 0.9);
  assert.equal(result.top_facts[0].chunk_text, 'design distributed systems');
  assert.equal(result.top_facts[1].fact_id, 'f3');
  assert.equal(result.top_facts[1].score, 0.5);
  assert.equal(result.score, (0.9 + 0.5) / 2);
});

test('computeMatchCoverage: empty profile (no facts returned per chunk) → score 0', async () => {
  const chunks = [
    { chunk_index: 0, chunk_text: 'a', vector: new Float32Array([1]) },
    { chunk_index: 1, chunk_text: 'b', vector: new Float32Array([0]) },
  ];
  const search = makeSearch({}); // no rankings → empty arrays back
  const result = await computeMatchCoverage(chunks, { profileId: 'p1', search });
  assert.equal(result.score, 0);
  assert.equal(result.top_facts.length, 2);
  for (const f of result.top_facts) {
    assert.equal(f.fact_id, null);
    assert.equal(f.score, 0);
  }
});

test('computeMatchCoverage: score bounded [0, 1] for typical inputs', async () => {
  const chunks = [
    { chunk_index: 0, chunk_text: 'a', vector: new Float32Array([1]) },
    { chunk_index: 1, chunk_text: 'b', vector: new Float32Array([1]) },
  ];
  const search = makeSearch({
    0: [{ fact_id: 'f1', score: 1.0 }],
    1: [{ fact_id: 'f2', score: 0.0 }],
  });
  const result = await computeMatchCoverage(chunks, { profileId: 'p1', search });
  assert.equal(result.score, 0.5);
  assert.ok(result.score >= 0 && result.score <= 1);
});

test('computeMatchCoverage: preserves chunk_index and chunk_text in top_facts', async () => {
  const chunks = [
    { chunk_index: 7, chunk_text: 'requirement 7', vector: new Float32Array([1]) },
    { chunk_index: 12, chunk_text: 'requirement 12', vector: new Float32Array([1]) },
  ];
  const search = makeSearch({
    0: [{ fact_id: 'a', score: 0.6 }],
    1: [{ fact_id: 'b', score: 0.3 }],
  });
  const result = await computeMatchCoverage(chunks, { profileId: 'p1', search });
  assert.equal(result.top_facts[0].chunk_index, 7);
  assert.equal(result.top_facts[0].chunk_text, 'requirement 7');
  assert.equal(result.top_facts[1].chunk_index, 12);
  assert.equal(result.top_facts[1].chunk_text, 'requirement 12');
});

test('computeMatchCoverage: passes topKPerQuery=1 and profileId to search', async () => {
  let captured = null;
  const search = async (queries, opts) => {
    captured = opts;
    return queries.map(() => [{ fact_id: 'x', score: 0.5 }]);
  };
  const chunks = [{ chunk_index: 0, chunk_text: 't', vector: new Float32Array([1]) }];
  await computeMatchCoverage(chunks, { profileId: 'p-abc', search });
  assert.equal(captured.profileId, 'p-abc');
  assert.equal(captured.topKPerQuery, 1);
});

// ---------- Section weighting ----------

test('sectionWeight: requirements / qualifications / must-have → 1.25', () => {
  assert.equal(sectionWeight('Requirements'), 1.25);
  assert.equal(sectionWeight('Qualifications'), 1.25);
  assert.equal(sectionWeight('Must have'), 1.25);
  assert.equal(sectionWeight('Required Qualifications'), 1.25);
  assert.equal(sectionWeight("What you'll need"), 1.25);
});

test('sectionWeight: nice-to-have / preferred / bonus → 0.75', () => {
  assert.equal(sectionWeight('Nice to have'), 0.75);
  assert.equal(sectionWeight('Preferred Qualifications'), 0.75); // preferred wins
  assert.equal(sectionWeight('Bonus'), 0.75);
  assert.equal(sectionWeight('Plus'), 0.75);
});

test('sectionWeight: unknown / null / responsibilities → 1.0', () => {
  assert.equal(sectionWeight(null), 1.0);
  assert.equal(sectionWeight(undefined), 1.0);
  assert.equal(sectionWeight(''), 1.0);
  assert.equal(sectionWeight('Responsibilities'), 1.0);
  assert.equal(sectionWeight('What you will do'), 1.0);
  assert.equal(sectionWeight('The Role'), 1.0);
});

test('computeMatchCoverage: weights chunks by section (requirements > responsibilities > nice-to-have)', async () => {
  const chunks = [
    {
      chunk_index: 0,
      chunk_text: 'must have python',
      section: 'Requirements',
      vector: new Float32Array([1]),
    },
    {
      chunk_index: 1,
      chunk_text: 'design systems',
      section: 'Responsibilities',
      vector: new Float32Array([1]),
    },
    {
      chunk_index: 2,
      chunk_text: 'kotlin a plus',
      section: 'Nice to have',
      vector: new Float32Array([1]),
    },
  ];
  const search = makeSearch({
    0: [{ fact_id: 'a', score: 0.9 }],
    1: [{ fact_id: 'b', score: 0.6 }],
    2: [{ fact_id: 'c', score: 0.2 }],
  });
  const result = await computeMatchCoverage(chunks, { profileId: 'p1', search });
  // Weighted mean: (1.25*0.9 + 1.0*0.6 + 0.75*0.2) / (1.25 + 1.0 + 0.75)
  //              = (1.125 + 0.6 + 0.15) / 3.0 = 0.625
  const expected = (1.25 * 0.9 + 1.0 * 0.6 + 0.75 * 0.2) / (1.25 + 1.0 + 0.75);
  assert.ok(Math.abs(result.score - expected) < 1e-9);
  assert.equal(result.top_facts[0].weight, 1.25);
  assert.equal(result.top_facts[1].weight, 1.0);
  assert.equal(result.top_facts[2].weight, 0.75);
});

test('computeMatchCoverage: chunks with null section get weight 1.0 (raw-text fallback)', async () => {
  const chunks = [
    { chunk_index: 0, chunk_text: 'a', section: null, vector: new Float32Array([1]) },
    { chunk_index: 1, chunk_text: 'b', section: null, vector: new Float32Array([1]) },
  ];
  const search = makeSearch({
    0: [{ fact_id: 'x', score: 0.8 }],
    1: [{ fact_id: 'y', score: 0.4 }],
  });
  const result = await computeMatchCoverage(chunks, { profileId: 'p1', search });
  // All weights are 1.0 so weighted mean equals plain mean.
  assert.ok(Math.abs(result.score - 0.6) < 1e-9);
  for (const f of result.top_facts) assert.equal(f.weight, 1.0);
});
