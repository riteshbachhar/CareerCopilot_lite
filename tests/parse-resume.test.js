import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateResumeFacts } from '../src/profile/parse-resume.js';

test('validateResumeFacts: well-formed full input passes through', () => {
  const input = {
    facts: [
      { section: 'Experience', subsection: 'Stripe (2020–2024)', text: 'Led billing migration from MongoDB to Postgres.' },
      { section: 'Skills', subsection: null, text: 'Python, Go, TypeScript' },
      { section: 'Education', subsection: 'MIT (2014–2018)', text: 'BS Computer Science' },
    ],
  };
  const { valid, dropped } = validateResumeFacts(input);
  assert.equal(valid.length, 3);
  assert.deepEqual(dropped, []);
  assert.deepEqual(valid[0], input.facts[0]);
});

test('validateResumeFacts: rejects garbage root', () => {
  assert.deepEqual(validateResumeFacts(null).valid, []);
  assert.deepEqual(validateResumeFacts(undefined).valid, []);
  assert.deepEqual(validateResumeFacts(42).valid, []);
  assert.deepEqual(validateResumeFacts('hello').valid, []);
  assert.deepEqual(validateResumeFacts([]).valid, []);
});

test('validateResumeFacts: missing facts array drops root', () => {
  const { valid, dropped } = validateResumeFacts({ items: [] });
  assert.deepEqual(valid, []);
  assert.ok(dropped[0].includes('facts is not an array'));
});

test('validateResumeFacts: facts must be objects', () => {
  const { valid, dropped } = validateResumeFacts({
    facts: ['oops', null, 42, ['nope']],
  });
  assert.deepEqual(valid, []);
  assert.equal(dropped.length, 4);
});

test('validateResumeFacts: missing section drops the fact', () => {
  const { valid, dropped } = validateResumeFacts({
    facts: [
      { section: '', text: 'Some claim' },
      { text: 'No section' },
      { section: '   ', text: 'Whitespace section' },
      { section: 'Real', text: 'Kept' },
    ],
  });
  assert.equal(valid.length, 1);
  assert.equal(valid[0].text, 'Kept');
  assert.equal(dropped.length, 3);
});

test('validateResumeFacts: text too short or missing drops the fact', () => {
  const { valid, dropped } = validateResumeFacts({
    facts: [
      { section: 'Skills', text: '' },
      { section: 'Skills', text: 'ab' },
      { section: 'Skills' },
      { section: 'Skills', text: 'OK enough' },
    ],
  });
  assert.equal(valid.length, 1);
  assert.equal(valid[0].text, 'OK enough');
  assert.equal(dropped.length, 3);
});

test('validateResumeFacts: subsection optional, normalized to null when empty', () => {
  const { valid } = validateResumeFacts({
    facts: [
      { section: 'Skills', subsection: null, text: 'Python' },
      { section: 'Skills', subsection: '', text: 'Golang' },
      { section: 'Skills', subsection: '   ', text: 'TypeScript' },
      { section: 'Skills', text: 'Rust' },
    ],
  });
  assert.equal(valid.length, 4);
  assert.ok(valid.every((f) => f.subsection === null));
});

test('validateResumeFacts: subsection trimmed', () => {
  const { valid } = validateResumeFacts({
    facts: [
      { section: 'Experience', subsection: '  Stripe  ', text: 'Built things' },
    ],
  });
  assert.equal(valid[0].subsection, 'Stripe');
});

test('validateResumeFacts: text and section trimmed', () => {
  const { valid } = validateResumeFacts({
    facts: [
      { section: '  Experience  ', subsection: null, text: '   Did stuff   ' },
    ],
  });
  assert.equal(valid[0].section, 'Experience');
  assert.equal(valid[0].text, 'Did stuff');
});

test('validateResumeFacts: extra unknown fact fields silently ignored', () => {
  const { valid } = validateResumeFacts({
    facts: [
      { section: 'Skills', text: 'Python', confidence: 0.9, source: 'page 1' },
    ],
  });
  assert.deepEqual(valid[0], { section: 'Skills', subsection: null, text: 'Python' });
});

test('validateResumeFacts: type-mismatched fields dropped', () => {
  const { valid, dropped } = validateResumeFacts({
    facts: [
      { section: 123, text: 'oops' },
      { section: 'Skills', text: 42 },
      { section: ['Skills'], text: 'arr' },
    ],
  });
  assert.deepEqual(valid, []);
  assert.equal(dropped.length, 3);
});

test('validateResumeFacts: realistic mixed input', () => {
  const { valid, dropped } = validateResumeFacts({
    facts: [
      { section: 'Experience', subsection: 'Stripe (2020-2024)', text: 'Led billing migration.' },
      { section: 'Experience', subsection: 'Stripe (2020-2024)', text: 'Mentored 3 juniors.' },
      { section: 'Skills', subsection: null, text: 'Python, Go, Rust' },
      { section: '', text: 'Should be dropped' },
      { section: 'Education', subsection: 'MIT', text: 'BS CS' },
    ],
  });
  assert.equal(valid.length, 4);
  assert.equal(dropped.length, 1);
});
