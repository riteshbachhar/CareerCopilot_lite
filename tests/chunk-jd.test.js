import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkJD } from '../src/chunk-jd.js';

test('chunkJD: empty / null / undefined input returns []', () => {
  assert.deepEqual(chunkJD({}), []);
  assert.deepEqual(chunkJD({ raw_text: '' }), []);
  assert.deepEqual(chunkJD({ raw_text: '   \n\n  ' }), []);
  assert.deepEqual(chunkJD({ raw_text: null, cleaned_text: null }), []);
  assert.deepEqual(chunkJD(), []);
});

test('chunkJD: cleaned_text path splits H2 sections into bullet chunks', () => {
  const cleaned = [
    '## Responsibilities',
    '- Design and ship distributed systems at scale across many regions',
    '- Lead architecture reviews and mentor more junior engineers daily',
    '## Requirements',
    '- 5+ years of Python or Go in production environments at scale',
    '- Experience with Kubernetes operators and service mesh patterns',
  ].join('\n');
  const chunks = chunkJD({ cleaned_text: cleaned, raw_text: '' });
  assert.equal(chunks.length, 4);
  assert.match(chunks[0].text, /Design and ship distributed systems/);
  assert.equal(chunks[0].section, 'Responsibilities');
  assert.match(chunks[3].text, /Kubernetes operators/);
  assert.equal(chunks[3].section, 'Requirements');
});

test('chunkJD: H3 under H2 overrides the section tag (most recent heading wins)', () => {
  const cleaned = [
    '## Requirements',
    '### Must have',
    '- 5+ years of Python or Go in production environments at scale',
    '### Nice to have',
    '- Experience with Kubernetes operators and service mesh patterns',
  ].join('\n');
  const chunks = chunkJD({ cleaned_text: cleaned });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].section, 'Must have');
  assert.equal(chunks[1].section, 'Nice to have');
});

test('chunkJD: raw_text without headings yields section: null', () => {
  const raw = [
    '- Lead a team of eight engineers building the core scheduling system',
    '- Own the on-call rotation and incident response for production services',
  ].join('\n');
  const chunks = chunkJD({ raw_text: raw });
  assert.equal(chunks.length, 2);
  for (const c of chunks) assert.equal(c.section, null);
});

test('chunkJD: drops boilerplate sections (Benefits, EEO, About us)', () => {
  const cleaned = [
    '## Requirements',
    '- 5+ years of backend engineering with strong fundamentals in databases',
    '## Benefits',
    '- Free lunch every day in the office plus snacks and drinks',
    '- Unlimited paid time off with no upper cap on vacation days',
    '## About Us',
    '- We are a fast-growing startup backed by top-tier investors and growing fast',
    '## Equal Opportunity',
    '- We are an equal opportunity employer and do not discriminate based on anything',
  ].join('\n');
  const chunks = chunkJD({ cleaned_text: cleaned });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /5\+ years of backend/);
});

test('chunkJD: raw_text fallback splits bullet blocks into one chunk per bullet', () => {
  const raw = [
    'Engineering Manager — Platform',
    '',
    'What you will do:',
    '- Lead a team of eight engineers building the core scheduling system',
    '- Own the on-call rotation and incident response for production services',
    '- Partner with product to define the roadmap and priorities each quarter',
  ].join('\n');
  const chunks = chunkJD({ raw_text: raw });
  // The "What you will do:" line is < MIN_WORDS, gets filtered. 3 bullets remain.
  assert.equal(chunks.length, 3);
  assert.match(chunks[0].text, /Lead a team of eight engineers/);
});

test('chunkJD: raw_text prose path splits paragraphs into sentences', () => {
  const raw = [
    'You will design distributed systems and ship them to production at scale. ' +
      'You will collaborate with product managers across multiple time zones. ' +
      'You will mentor more junior engineers and grow their technical skills.',
  ].join('\n');
  const chunks = chunkJD({ raw_text: raw });
  assert.equal(chunks.length, 3);
  assert.match(chunks[0].text, /design distributed systems/);
  assert.match(chunks[1].text, /collaborate with product managers/);
  assert.match(chunks[2].text, /mentor more junior engineers/);
});

test('chunkJD: prefers cleaned_text when both supplied', () => {
  const cleaned = '## Responsibilities\n- Build and ship distributed systems daily across regions';
  const raw = '- raw bullet that should not appear because cleaned is preferred';
  const chunks = chunkJD({ raw_text: raw, cleaned_text: cleaned });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /Build and ship distributed systems/);
});

test('chunkJD: filters chunks that are too short', () => {
  const raw = [
    '- short bullet', // 2 words, dropped
    '- This bullet has more than six words and should survive', // kept
  ].join('\n');
  const chunks = chunkJD({ raw_text: raw });
  assert.equal(chunks.length, 1);
});

test('chunkJD: filters boilerplate chunks (apply now, EEO, click here)', () => {
  const raw = [
    '- Apply now to join our amazing team and ship great things together',
    '- Click here to submit your resume and cover letter for review',
    '- We are an equal opportunity employer that values diverse perspectives',
    '- Build and ship distributed systems at scale across many regions',
  ].join('\n');
  const chunks = chunkJD({ raw_text: raw });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /Build and ship distributed systems/);
});

test('chunkJD: truncates over-long chunks at MAX_WORDS', () => {
  const longBullet =
    '- ' +
    Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
  const chunks = chunkJD({ raw_text: longBullet });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.endsWith('…'));
  // Truncated to ~60 words (MAX_WORDS) plus the ellipsis.
  assert.ok(chunks[0].text.split(/\s+/).length <= 61);
});

test('chunkJD: caps total chunks at 30', () => {
  const bullets = Array.from(
    { length: 50 },
    (_, i) => `- Bullet number ${i} describes a particular requirement of this role nicely`,
  ).join('\n');
  const chunks = chunkJD({ raw_text: bullets });
  assert.equal(chunks.length, 30);
});

test('chunkJD: dedupes identical chunks', () => {
  const cleaned = [
    '## Requirements',
    '- 5+ years of Python or Go in production at scale across systems',
    '- 5+ years of Python or Go in production at scale across systems',
    '- Strong communication skills with cross-functional partners and stakeholders',
  ].join('\n');
  const chunks = chunkJD({ cleaned_text: cleaned });
  assert.equal(chunks.length, 2);
});

test('chunkJD: handles \\r\\n line endings', () => {
  const raw = [
    '- Build and ship distributed systems at scale across many regions',
    '- Lead architecture reviews and mentor junior engineers on the team',
  ].join('\r\n');
  const chunks = chunkJD({ raw_text: raw });
  assert.equal(chunks.length, 2);
});

test('chunkJD: numbered list bullets recognized as bullets', () => {
  const raw = [
    '1. First requirement that the candidate must meet to be considered for this role',
    '2. Second requirement that the candidate should also possess to do well here',
    '3. Third requirement around team collaboration and cross-functional partnership',
  ].join('\n');
  const chunks = chunkJD({ raw_text: raw });
  assert.equal(chunks.length, 3);
  assert.match(chunks[0].text, /^First requirement/);
});
