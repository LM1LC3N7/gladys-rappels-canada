// The download of the open data file against the fake server: conditional
// requests, honest User-Agent, bounded size and time, the columns of both
// languages, the cleaning of the texts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_AGENT, clean, download, normalizeRecord, retryAfterMs } from '../src/source.js';
import { FILE_EN, FILE_FR, startServer } from './helpers/server.js';

const all = () => true;
const TIMEOUTS = { headers: 2000, stall: 300, total: 10000 };

async function server(t) {
  const srv = await startServer();
  t.after(() => srv.close());
  return srv;
}

test('200 then 304: the validators are sent back, the User-Agent names the integration', async (t) => {
  const srv = await server(t);
  const first = await download({
    fetch,
    language: 'en',
    baseUrl: srv.baseUrl,
    keep: all,
    timeouts: TIMEOUTS,
  });
  assert.equal(first.modified, true);
  assert.equal(first.nids.length, srv.records.en.length);
  assert.equal(first.records.length, srv.records.en.length);
  assert.equal(first.etag, '"fake-en-1"');
  assert.equal(first.lastModified, 'Thu, 29 Oct 2026 02:14:39 GMT');
  assert.equal(first.date, Date.parse('2026-10-29T16:00:00Z'));
  const second = await download({
    fetch,
    language: 'en',
    baseUrl: srv.baseUrl,
    etag: first.etag,
    lastModified: first.lastModified,
    keep: all,
    timeouts: TIMEOUTS,
  });
  assert.deepEqual(second, {
    modified: false,
    date: Date.parse('2026-10-29T16:00:00Z'),
    lastModified: 'Thu, 29 Oct 2026 02:14:39 GMT',
  });
  const [a, b] = srv.requests;
  assert.ok(a.url.endsWith(FILE_EN));
  assert.equal(a.headers['if-none-match'], undefined);
  assert.equal(b.headers['if-none-match'], '"fake-en-1"');
  assert.equal(b.headers['if-modified-since'], 'Thu, 29 Oct 2026 02:14:39 GMT');
  for (const request of srv.requests) {
    assert.equal(request.headers['user-agent'], USER_AGENT);
    assert.doesNotMatch(request.headers['user-agent'], /Mozilla|Chrome|Safari/);
  }
});

test('a validator holding a control character is not sent', async (t) => {
  const srv = await server(t);
  await download({
    fetch,
    language: 'fr',
    baseUrl: srv.baseUrl,
    etag: '"a"\r\nX-Evil: 1',
    lastModified: 'x\ny',
    keep: all,
    timeouts: TIMEOUTS,
  });
  const [request] = srv.requests;
  assert.ok(request.url.endsWith(FILE_FR));
  assert.equal(request.headers['if-none-match'], undefined);
  assert.equal(request.headers['if-modified-since'], undefined);
  assert.equal(request.headers['x-evil'], undefined);
});

test('the French file is read with its own columns', async (t) => {
  const srv = await server(t);
  const result = await download({
    fetch,
    language: 'fr',
    baseUrl: srv.baseUrl,
    keep: all,
    timeouts: TIMEOUTS,
  });
  const record = result.records.find((r) => r.nid === '82848');
  assert.equal(record.category, 'food');
  assert.equal(record.updated, '2026-10-23');
  assert.equal(record.recallClass, 'Classe 1');
  assert.match(record.url, /^https:\/\/recalls-rappels\.canada\.ca\/fr\//);
  assert.ok(record.title.length > 0 && record.issue.length > 0);
});

test('only the sheets `keep` accepts stay in memory, every NID is listed', async (t) => {
  const srv = await server(t);
  const result = await download({
    fetch,
    language: 'en',
    baseUrl: srv.baseUrl,
    keep: (r) => r.updated === '2026-10-28',
    timeouts: TIMEOUTS,
  });
  assert.equal(result.nids.length, srv.records.en.length);
  assert.ok(result.records.length > 0);
  assert.ok(result.records.every((r) => r.updated === '2026-10-28'));
});

test('an announced size beyond the bound is refused before reading the body', async (t) => {
  const srv = await server(t);
  srv.fault = 'oversize';
  await assert.rejects(
    download({ fetch, language: 'en', baseUrl: srv.baseUrl, keep: all, timeouts: TIMEOUTS }),
    /more than/,
  );
});

test('a body growing beyond the bound without Content-Length is cut', async (t) => {
  const srv = await server(t);
  srv.fault = 'chunked-oversize';
  await assert.rejects(
    download({
      fetch,
      language: 'en',
      baseUrl: srv.baseUrl,
      keep: all,
      timeouts: TIMEOUTS,
      maxBytes: 5 * 1024 * 1024,
    }),
    /more than 5242880 bytes/,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(srv.chunkedSent < 200, `the server could send only ${srv.chunkedSent} of 200 MB`);
});

test('a body that stalls is given up', async (t) => {
  const srv = await server(t);
  srv.fault = 'stall';
  const started = performance.now();
  await assert.rejects(
    download({ fetch, language: 'en', baseUrl: srv.baseUrl, keep: all, timeouts: TIMEOUTS }),
    /no data for 0.3 s/,
  );
  assert.ok(performance.now() - started < 3000);
});

test('HTTP errors carry the status and Retry-After; a dropped connection is an error', async (t) => {
  const srv = await server(t);
  srv.fault = 503;
  srv.retryAfter = 120;
  await assert.rejects(
    download({ fetch, language: 'en', baseUrl: srv.baseUrl, keep: all, timeouts: TIMEOUTS }),
    (err) => err.status === 503 && err.retryAfterMs === 120000,
  );
  srv.fault = 'drop';
  await assert.rejects(
    download({ fetch, language: 'en', baseUrl: srv.baseUrl, keep: all, timeouts: TIMEOUTS }),
    (err) => err.status === null && /127\.0\.0\.1/.test(err.message),
  );
});

test('a file that is not an array of sheets is an error, never an empty list', async (t) => {
  const srv = await server(t);
  for (const body of ['{"error":"maintenance"}', '[]', '<html>Maintenance</html>', '[{"NID":"1"']) {
    srv.raw = { en: body };
    await assert.rejects(
      download({ fetch, language: 'en', baseUrl: srv.baseUrl, keep: all, timeouts: TIMEOUTS }),
      /unexpected file|empty file/,
      body,
    );
  }
});

test('Retry-After as an HTTP date is read against the Date header', () => {
  const headers = new Headers({
    'retry-after': 'Thu, 29 Oct 2026 16:10:00 GMT',
    date: 'Thu, 29 Oct 2026 16:00:00 GMT',
  });
  assert.equal(retryAfterMs(headers), 600000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Thu, 29 Oct 2026 16:10:00 GMT' })), null);
  assert.equal(retryAfterMs(new Headers()), null);
});

test('texts lose zero-width and control characters, and are clipped', () => {
  assert.equal(clean('​​Magic Balloon​  kits\u0007\n'), 'Magic Balloon kits');
  assert.equal(clean('a'.repeat(20), 10), `${'a'.repeat(9)}…`);
  assert.equal(clean(null), '');
  // The entities of the files (&nbsp; by the thousands, &amp;, &rsquo;…), numeric ones too.
  assert.equal(clean('guidelines.&nbsp;For'), 'guidelines. For');
  assert.equal(
    clean('Apple &amp; Berry l&rsquo;eau &#233;t&#xE9; &lt;b&gt; &bogus;'),
    'Apple & Berry l’eau été <b> &bogus;',
  );
  assert.equal(clean('a&#0;b&#xD800;c'), 'a b c');
});

test('a sheet without a usable NID is dropped; a foreign URL is replaced by the site', () => {
  assert.equal(normalizeRecord({ NID: 'abc', Title: 'x' }, 'en'), null);
  assert.equal(normalizeRecord({ NID: '' }, 'en'), null);
  assert.equal(normalizeRecord([], 'en'), null);
  const record = normalizeRecord(
    {
      NID: '1',
      Title: 'T',
      URL: 'http://evil.example/x',
      Organization: 'Nope',
      'Last updated': '2026-13',
    },
    'en',
  );
  assert.equal(record.url, 'https://recalls-rappels.canada.ca/en');
  assert.equal(record.category, 'other');
  assert.equal(record.updated, null);
  assert.equal(record.archived, false);
});
