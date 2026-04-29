import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseImportText,
  parseCsv,
  detectFormat,
} from '../src/import-jobs.js';

// ---------- detectFormat ----------

test('detectFormat: empty / whitespace returns null', () => {
  assert.equal(detectFormat(''), null);
  assert.equal(detectFormat('   \n\t '), null);
});

test('detectFormat: starts with [ → json', () => {
  assert.equal(detectFormat('[]'), 'json');
  assert.equal(detectFormat('  \n[{"a":1}]'), 'json');
});

test('detectFormat: starts with { → json', () => {
  assert.equal(detectFormat('{"rows": []}'), 'json');
});

test('detectFormat: anything else → csv', () => {
  assert.equal(detectFormat('id,title,raw_text\n'), 'csv');
  assert.equal(detectFormat('"quoted",field'), 'csv');
});

test('detectFormat: BOM is stripped before checking', () => {
  assert.equal(detectFormat('﻿[]'), 'json');
  assert.equal(detectFormat('﻿id,title\n'), 'csv');
});

// ---------- parseCsv ----------

test('parseCsv: simple unquoted rows', () => {
  const out = parseCsv('a,b,c\n1,2,3\n4,5,6');
  assert.deepEqual(out, [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
});

test('parseCsv: handles trailing newline without producing empty row', () => {
  const out = parseCsv('a,b\n1,2\n');
  assert.deepEqual(out, [['a', 'b'], ['1', '2']]);
});

test('parseCsv: quoted field with comma', () => {
  const out = parseCsv('a,b\n"hello, world",2');
  assert.deepEqual(out, [['a', 'b'], ['hello, world', '2']]);
});

test('parseCsv: doubled-quote escapes a literal quote', () => {
  const out = parseCsv('a\n"she said ""hi"""');
  assert.deepEqual(out, [['a'], ['she said "hi"']]);
});

test('parseCsv: quoted field with embedded newline', () => {
  const out = parseCsv('a,b\n"line 1\nline 2",x');
  assert.deepEqual(out, [['a', 'b'], ['line 1\nline 2', 'x']]);
});

test('parseCsv: handles CRLF line endings', () => {
  const out = parseCsv('a,b\r\n1,2\r\n3,4');
  assert.deepEqual(out, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('parseCsv: strips BOM', () => {
  const out = parseCsv('﻿a,b\n1,2');
  assert.deepEqual(out, [['a', 'b'], ['1', '2']]);
});

test('parseCsv: empty fields preserved', () => {
  const out = parseCsv('a,b,c\n1,,3');
  assert.deepEqual(out, [['a', 'b', 'c'], ['1', '', '3']]);
});

// ---------- parseImportText: JSON ----------

test('parseImportText json: rejects non-array top level', () => {
  const { rows, errors } = parseImportText('{"foo": 1}');
  assert.equal(rows.length, 0);
  assert.match(errors[0].message, /array/i);
});

test('parseImportText json: rejects malformed JSON', () => {
  const { rows, errors } = parseImportText('[not json');
  assert.equal(rows.length, 0);
  assert.match(errors[0].message, /parse failed/i);
});

test('parseImportText json: skips rows missing raw_text', () => {
  const text = JSON.stringify([
    { url: 'https://a', title: 'T', raw_text: 'body one' },
    { url: 'https://b', title: 'T2' }, // missing raw_text
    { url: 'https://c', title: 'T3', raw_text: '' }, // empty raw_text
  ]);
  const { rows, errors } = parseImportText(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://a');
  assert.equal(errors.length, 2);
});

test('parseImportText json: full round-trip shape preserved', () => {
  const text = JSON.stringify([
    {
      url: 'https://a',
      title: 'Senior Engineer',
      company: 'Acme',
      timestamp: 1700000000000,
      raw_text: 'job body here',
      cleaned_text: '## Reqs\n- foo',
      oneliner: 'Senior Engineer at Acme',
      structured_fields: { location: 'Remote', seniority: 'senior' },
      status: 'applied',
      status_history: [
        { status: 'interested', at: 1700000000000 },
        { status: 'applied', at: 1700001000000 },
      ],
      notes: 'high priority',
      follow_up_at: 1700002000000,
      tags: ['ml', 'remote'],
    },
  ]);
  const { rows, errors } = parseImportText(text);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.url, 'https://a');
  assert.equal(r.title, 'Senior Engineer');
  assert.equal(r.timestamp, 1700000000000);
  assert.equal(r.raw_text, 'job body here');
  assert.equal(r.cleaned_text, '## Reqs\n- foo');
  assert.equal(r.oneliner, 'Senior Engineer at Acme');
  assert.deepEqual(r.structured_fields, { location: 'Remote', seniority: 'senior' });
  assert.equal(r.status, 'applied');
  assert.equal(r.status_history.length, 2);
  assert.equal(r.notes, 'high priority');
  assert.equal(r.follow_up_at, 1700002000000);
  assert.deepEqual(r.tags, ['ml', 'remote']);
});

test('parseImportText json: filters non-string tags and bad status_history', () => {
  const text = JSON.stringify([
    {
      raw_text: 'body',
      tags: ['ok', 42, null, 'good'],
      status_history: [
        { status: 'applied', at: 1 },
        { status: 'bad' }, // missing at
        null,
      ],
    },
  ]);
  const { rows } = parseImportText(text);
  assert.deepEqual(rows[0].tags, ['ok', 'good']);
  assert.equal(rows[0].status_history.length, 1);
});

// ---------- parseImportText: CSV ----------

test('parseImportText csv: rejects header without raw_text column', () => {
  const text = 'id,title,company\n1,T,A';
  const { rows, errors } = parseImportText(text);
  assert.equal(rows.length, 0);
  assert.match(errors[0].message, /raw_text/i);
});

test('parseImportText csv: parses standard export header', () => {
  const text =
    'id,title,company,url,status,captured_at,follow_up_at,location,seniority,salary,source,notes,raw_text,status_history\n' +
    'abc,Senior Eng,Acme,https://a,applied,2024-01-01T10:00:00.000Z,2024-02-01,Remote,senior,$200k,paste,my notes,"the job body",interested@2024-01-01T10:00:00.000Z › applied@2024-01-05T12:00:00.000Z';
  const { rows, errors } = parseImportText(text);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.url, 'https://a');
  assert.equal(r.title, 'Senior Eng');
  assert.equal(r.company, 'Acme');
  assert.equal(r.raw_text, 'the job body');
  assert.equal(r.status, 'applied');
  assert.equal(r.notes, 'my notes');
  assert.equal(r.timestamp, Date.parse('2024-01-01T10:00:00.000Z'));
  assert.equal(r.follow_up_at, Date.parse('2024-02-01'));
  assert.equal(r.structured_fields.location, 'Remote');
  assert.equal(r.structured_fields.seniority, 'senior');
  assert.equal(r.structured_fields.salary_label, '$200k');
  assert.equal(r.status_history.length, 2);
  assert.equal(r.status_history[0].status, 'interested');
  assert.equal(r.status_history[1].status, 'applied');
});

test('parseImportText csv: skips rows with empty raw_text', () => {
  const text = 'url,raw_text\nhttps://a,body 1\nhttps://b,\nhttps://c,body 3';
  const { rows, errors } = parseImportText(text);
  assert.equal(rows.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(rows[0].url, 'https://a');
  assert.equal(rows[1].url, 'https://c');
});

test('parseImportText csv: tolerates blank lines between rows', () => {
  const text = 'url,raw_text\n\nhttps://a,body\n\nhttps://b,body2\n';
  const { rows } = parseImportText(text);
  assert.equal(rows.length, 2);
});

test('parseImportText: empty input returns errors, no rows', () => {
  const { rows, errors } = parseImportText('');
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
});

test('parseImportText: explicit format hint overrides detection', () => {
  // Looks like CSV by detection, but caller asserts json — should error not silently parse as CSV.
  const { rows, errors } = parseImportText('id,raw_text\n1,body', { format: 'json' });
  assert.equal(rows.length, 0);
  assert.match(errors[0].message, /parse failed/i);
});
