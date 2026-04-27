import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseProfileMarkdown } from '../src/profile/parse-markdown.js';

test('parseProfileMarkdown: empty input returns empty array', () => {
  assert.deepEqual(parseProfileMarkdown(''), []);
  assert.deepEqual(parseProfileMarkdown(null), []);
  assert.deepEqual(parseProfileMarkdown(undefined), []);
});

test('parseProfileMarkdown: bullet under H2 picks up section, subsection null', () => {
  const md = `## Experience\n- Worked at Anthropic on Claude.`;
  const facts = parseProfileMarkdown(md);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].section, 'Experience');
  assert.equal(facts[0].subsection, null);
  assert.equal(facts[0].text, 'Worked at Anthropic on Claude.');
  assert.equal(facts[0].order, 0);
});

test('parseProfileMarkdown: H3 sets subsection within the current section', () => {
  const md = [
    '## Experience',
    '### Anti-fraud at Stripe',
    '- Trained graph ML on transactions.',
    '- Shipped to production.',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.equal(facts.length, 2);
  for (const f of facts) {
    assert.equal(f.section, 'Experience');
    assert.equal(f.subsection, 'Anti-fraud at Stripe');
  }
});

test('parseProfileMarkdown: order field increments across sections', () => {
  const md = [
    '## A',
    '- one',
    '- two',
    '## B',
    '- three',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.deepEqual(
    facts.map((f) => f.order),
    [0, 1, 2],
  );
  assert.equal(facts[2].section, 'B');
});

test('parseProfileMarkdown: new H2 resets subsection to null', () => {
  const md = [
    '## Experience',
    '### Project A',
    '- a fact',
    '## Education',
    '- a degree',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.equal(facts[0].subsection, 'Project A');
  assert.equal(facts[1].section, 'Education');
  assert.equal(facts[1].subsection, null);
});

test('parseProfileMarkdown: bullets before any heading have section: null', () => {
  const md = [`- orphan fact at the top`, `## Section`, `- in-section`].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].section, null);
  assert.equal(facts[0].subsection, null);
  assert.equal(facts[1].section, 'Section');
});

test('parseProfileMarkdown: [ADD] placeholders are skipped', () => {
  const md = [
    '## Experience',
    '- real fact',
    '- [ADD] something to add later',
    '- [add] case-insensitive',
    '- another real fact',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.equal(facts.length, 2);
  assert.deepEqual(
    facts.map((f) => f.text),
    ['real fact', 'another real fact'],
  );
});

test('parseProfileMarkdown: task-list checkboxes ([ ], [x], [X]) are skipped', () => {
  const md = [
    '## Todos',
    '- [ ] open todo',
    '- [x] done todo',
    '- [X] uppercase done',
    '- a real bullet',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].text, 'a real bullet');
});

test('parseProfileMarkdown: [VERIFY] bullets are kept (flagged but content)', () => {
  const md = `## Experience\n- [VERIFY] this number might be off`;
  const facts = parseProfileMarkdown(md);
  assert.equal(facts.length, 1);
  assert.match(facts[0].text, /^\[VERIFY\]/);
});

test('parseProfileMarkdown: HTML comments are stripped (single-line)', () => {
  const md = [
    '## A',
    '- visible',
    '<!-- - hidden -->',
    '- also visible',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.deepEqual(
    facts.map((f) => f.text),
    ['visible', 'also visible'],
  );
});

test('parseProfileMarkdown: HTML comments are stripped (multi-line)', () => {
  const md = [
    '## A',
    '- before',
    '<!--',
    '## Hidden Section',
    '- this should never appear',
    '-->',
    '- after',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.deepEqual(
    facts.map((f) => f.text),
    ['before', 'after'],
  );
  // Sanity: the commented-out H2 must not have set the section.
  assert.equal(facts[1].section, 'A');
});

test('parseProfileMarkdown: blockquoted bullets (> -) are NOT counted', () => {
  // The bullet regex is anchored at line start, so "> - x" never matches.
  const md = [
    '## Experience',
    '- a real bullet',
    '> - this is in a blockquote, ignore me',
    '> nested quote text',
    '- another real bullet',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  assert.equal(facts.length, 2);
});

test('parseProfileMarkdown: handles \\r\\n line endings', () => {
  const md = `## A\r\n- one\r\n- two\r\n`;
  const facts = parseProfileMarkdown(md);
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((f) => f.text), ['one', 'two']);
});

test('parseProfileMarkdown: trims trailing whitespace from heading + bullet text', () => {
  const md = `## Experience   \n-    leading and trailing spaces   `;
  const facts = parseProfileMarkdown(md);
  assert.equal(facts[0].section, 'Experience');
  assert.equal(facts[0].text, 'leading and trailing spaces');
});

test('parseProfileMarkdown: empty bullet "- " is skipped', () => {
  const md = [
    '## A',
    '- real fact',
    '-   ',
    '- another fact',
  ].join('\n');
  const facts = parseProfileMarkdown(md);
  // A bullet with only whitespace after `- ` doesn't match BULLET_RE
  // (the +.+? requires at least one non-whitespace character before the
  // optional trailing whitespace), so it falls through. Either way, the
  // resulting fact list shouldn't include an empty-text fact.
  for (const f of facts) {
    assert.notEqual(f.text, '');
  }
});

test('parseProfileMarkdown: realistic mini-profile produces expected facts', () => {
  const md = [
    '<!-- this is a comment header that should be stripped -->',
    '# My Profile',
    '',
    '## Experience',
    '',
    '### Stripe (2023–2026)',
    '- Built anti-fraud graph ML pipeline.',
    '- Shipped to production at 9.5M-transaction scale.',
    '- [ADD] specific PR-AUC number',
    '',
    '### Anthropic (2026–present)',
    '- Working on Claude alignment.',
    '',
    '## Education',
    '- BS Computer Science, URI, GPA 3.99/4.00.',
    '',
    '## Todos',
    '- [ ] write blog post',
    '- [x] ship the extension',
  ].join('\n');

  const facts = parseProfileMarkdown(md);

  // Three from Stripe (one [ADD] skipped), one from Anthropic, one from
  // Education, none from Todos. = 4? wait — Stripe has 2 real + 1 [ADD]
  // skipped = 2. Plus Anthropic 1, plus Education 1, plus Todos 0 = 4.
  assert.equal(facts.length, 4);

  // Section + subsection assignments propagate correctly.
  assert.equal(facts[0].section, 'Experience');
  assert.equal(facts[0].subsection, 'Stripe (2023–2026)');
  assert.equal(facts[2].section, 'Experience');
  assert.equal(facts[2].subsection, 'Anthropic (2026–present)');
  assert.equal(facts[3].section, 'Education');
  assert.equal(facts[3].subsection, null);

  // Order is contiguous 0..3.
  assert.deepEqual(facts.map((f) => f.order), [0, 1, 2, 3]);
});
