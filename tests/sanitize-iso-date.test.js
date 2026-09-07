import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeIsoDate } from '../src/llm/groq-client.js';

// sanitizeIsoDate is the only thing standing between a hallucinated date and
// a job row, so the cases that matter are the ones where the model returns
// something date-shaped but wrong.

test('sanitizeIsoDate: well-formed YYYY-MM-DD passes through unchanged', () => {
  assert.equal(sanitizeIsoDate('2026-03-14'), '2026-03-14');
  assert.equal(sanitizeIsoDate('2026-01-01'), '2026-01-01');
  assert.equal(sanitizeIsoDate('2026-12-31'), '2026-12-31');
  // Leap day in an actual leap year.
  assert.equal(sanitizeIsoDate('2028-02-29'), '2028-02-29');
});

test('sanitizeIsoDate: surrounding whitespace is trimmed', () => {
  assert.equal(sanitizeIsoDate('  2026-03-14  '), '2026-03-14');
  assert.equal(sanitizeIsoDate('\n2026-03-14\t'), '2026-03-14');
});

test('sanitizeIsoDate: a full ISO timestamp keeps only the date part', () => {
  assert.equal(sanitizeIsoDate('2026-03-14T09:30:00Z'), '2026-03-14');
  assert.equal(sanitizeIsoDate('2026-03-14T00:00:00+05:30'), '2026-03-14');
});

test('sanitizeIsoDate: non-strings and empties are rejected', () => {
  for (const v of [null, undefined, '', '   ', 42, {}, [], true, new Date()]) {
    assert.equal(sanitizeIsoDate(v), null);
  }
});

// The whole reason this validator round-trips through Date and compares the
// parts back: `new Date(Date.UTC(2026, 1, 31))` silently rolls forward to
// March 3 rather than failing, so a naive parse would accept Feb 31.
test('sanitizeIsoDate: calendar-impossible dates are rejected, not rolled forward', () => {
  assert.equal(sanitizeIsoDate('2026-02-31'), null);
  assert.equal(sanitizeIsoDate('2026-02-30'), null);
  assert.equal(sanitizeIsoDate('2026-04-31'), null);
  assert.equal(sanitizeIsoDate('2026-13-01'), null);
  assert.equal(sanitizeIsoDate('2026-00-10'), null);
  assert.equal(sanitizeIsoDate('2026-06-00'), null);
  assert.equal(sanitizeIsoDate('2026-06-32'), null);
  // Feb 29 in a non-leap year is the subtle one.
  assert.equal(sanitizeIsoDate('2026-02-29'), null);
});

test('sanitizeIsoDate: wrong shapes are rejected', () => {
  assert.equal(sanitizeIsoDate('03/14/2026'), null);
  assert.equal(sanitizeIsoDate('14-03-2026'), null);
  assert.equal(sanitizeIsoDate('2026-3-14'), null);   // unpadded
  assert.equal(sanitizeIsoDate('26-03-14'), null);    // 2-digit year
  assert.equal(sanitizeIsoDate('2026-03'), null);     // month precision only
  assert.equal(sanitizeIsoDate('2026'), null);
});

// The model is told to return null rather than compute a date it cannot
// know. If it disobeys and answers in prose, none of it survives.
test('sanitizeIsoDate: prose and relative dates are rejected', () => {
  assert.equal(sanitizeIsoDate('March 14, 2026'), null);
  assert.equal(sanitizeIsoDate('next Friday'), null);
  assert.equal(sanitizeIsoDate('3 days ago'), null);
  assert.equal(sanitizeIsoDate('rolling'), null);
  assert.equal(sanitizeIsoDate('null'), null);
  assert.equal(sanitizeIsoDate('N/A'), null);
  assert.equal(sanitizeIsoDate('open until filled'), null);
  // A date buried mid-sentence is not an extraction the model was asked for.
  assert.equal(sanitizeIsoDate('closes 2026-03-14'), null);
});

test('sanitizeIsoDate: implausible years are rejected', () => {
  assert.equal(sanitizeIsoDate('1999-12-31'), null);
  assert.equal(sanitizeIsoDate('1970-01-01'), null);
  assert.equal(sanitizeIsoDate('0001-01-01'), null);
  const year = new Date().getUTCFullYear();
  assert.equal(sanitizeIsoDate(`${year + 3}-01-01`), null);
  assert.equal(sanitizeIsoDate(`${year + 50}-01-01`), null);
});

// The bounds are inclusive on both ends; pinning them keeps a later tweak
// to the range from silently widening or narrowing what's accepted.
test('sanitizeIsoDate: year bounds are inclusive', () => {
  assert.equal(sanitizeIsoDate('2000-01-01'), '2000-01-01');
  const year = new Date().getUTCFullYear();
  assert.equal(sanitizeIsoDate(`${year + 2}-12-31`), `${year + 2}-12-31`);
  assert.equal(sanitizeIsoDate(`${year}-06-15`), `${year}-06-15`);
});

// Past deadlines are a display concern (the card strikes them through), not
// a validity one — a JD captured after its close date still has a real date.
test('sanitizeIsoDate: past-but-plausible dates are kept', () => {
  assert.equal(sanitizeIsoDate('2024-05-01'), '2024-05-01');
});
