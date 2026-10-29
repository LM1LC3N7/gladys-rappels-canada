// The streaming reader of the open data files: same result as JSON.parse on
// the raw captures (escaped slashes, \uXXXX), whatever the chunk boundaries;
// a broken frame is an error, a too large element is skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonArrayReader } from '../src/jsonArray.js';
import { fixture } from './helpers/server.js';

function readAll(text, size, options = {}) {
  const out = [];
  const reader = new JsonArrayReader({ onObject: (o) => out.push(o), ...options });
  for (let i = 0; i < text.length; i += size) {
    reader.write(text.slice(i, i + size));
  }
  reader.end();
  return { out, reader };
}

for (const name of ['HCRSAMOpenData-head.json', 'SCRSAMDonneesOuvertes-head.json']) {
  test(`${name} (raw capture) reads like JSON.parse, in chunks of any size`, () => {
    const text = fixture(name);
    assert.match(text, /\\\//, 'the capture keeps the escaped slashes');
    assert.match(text, /\\u[0-9a-f]{4}/, 'and the \\u escapes');
    const expected = JSON.parse(text);
    for (const size of [1, 2, 3, 7, 64, 1000, text.length]) {
      assert.deepEqual(readAll(text, size).out, expected, `chunks of ${size}`);
    }
  });
}

test('braces, brackets and quotes inside strings do not end an element', () => {
  const text = '[ {"a":"}{]","b":"say \\"}\\" now","c":"\\\\"} , {"d":[1,{"e":2}]} ]';
  assert.deepEqual(readAll(text, 1).out, JSON.parse(text));
});

test('an empty array is read, and nothing else is accepted', () => {
  assert.deepEqual(readAll('  [ ] ', 1).out, []);
  for (const bad of [
    '{"a":1}',
    '[1,2]',
    '[{"a":1},]',
    '[,{"a":1}]',
    '[{"a":1}{"b":2}]',
    '[{"a":1}] x',
    '[{"a":}]',
  ]) {
    assert.throws(() => readAll(bad, 3), /JSON|array|element|unexpected|after/, bad);
  }
});

test('a file cut short is an error', () => {
  assert.throws(() => readAll('[{"a":1},{"b"', 4), /cut short/);
  assert.throws(() => readAll('[{"a":1}', 4), /cut short/);
  assert.throws(() => readAll('', 4), /cut short/);
});

test('an element larger than the bound is skipped, not kept, and the next one is read', () => {
  const big = 'x'.repeat(5000);
  const text = `[{"a":1},{"big":"${big}"},{"b":2}]`;
  const { out, reader } = readAll(text, 100, { maxObjectBytes: 1000 });
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  assert.equal(reader.skipped, 1);
  assert.equal(reader.count, 2);
});

test('the reading is linear: 20,000 elements in one pass', () => {
  const items = Array.from({ length: 20000 }, (_, i) => ({ NID: String(i), Title: `t{${i}}` }));
  const text = JSON.stringify(items);
  const started = performance.now();
  const { out } = readAll(text, 65536);
  assert.equal(out.length, 20000);
  assert.ok(performance.now() - started < 5000);
});
