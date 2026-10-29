// Review r1, I3: one test per guard a mutant could remove unnoticed, and the
// minor points m2 (bounds of /data), m4 (stop during a download), m7 (an older
// CDN edge answered with a 304).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CONFIG_RETRY_MAX_MS, CONFIG_RETRY_MS } from '../src/app.js';
import { MAX_KEYWORDS, parseKeywords } from '../src/config.js';
import { download } from '../src/source.js';
import { FILE_NAME, Store } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { FILE_EN, FILE_FR, newRecord, startServer } from './helpers/server.js';
import {
  HOUR,
  MINUTE,
  START,
  create,
  createWorld,
  featureId,
  idle,
  tempDir,
  tick,
} from './helpers/world.js';

const all = () => true;
const TIMEOUTS = { headers: 2000, stall: 300, total: 10000 };
const readData = async (dir) => JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8'));

async function server(t) {
  const srv = await startServer();
  t.after(() => srv.close());
  return srv;
}

// --- source.js ----------------------------------------------------------------

test('a slow but living stream is read: the stall delay is re-armed at each chunk', async (t) => {
  const srv = await server(t);
  srv.fault = 'slow';
  srv.slowMs = 150;
  const started = performance.now();
  const result = await download({
    fetch,
    language: 'en',
    baseUrl: srv.baseUrl,
    keep: all,
    timeouts: TIMEOUTS,
  });
  assert.ok(performance.now() - started > TIMEOUTS.stall, 'longer than the stall delay in all');
  assert.equal(result.nids.length, srv.records.en.length);
});

test('a redirect is refused, never followed', async (t) => {
  const srv = await server(t);
  srv.fault = 'redirect';
  await assert.rejects(
    download({ fetch, language: 'fr', baseUrl: srv.baseUrl, keep: all, timeouts: TIMEOUTS }),
    (err) => err.kind === 'redirect' || err.kind === 'network',
  );
  assert.equal(srv.count(FILE_EN), 0, 'the target of the redirect is never asked');
});

test('a stream that ends cleanly without closing the array is refused', async (t) => {
  const srv = await server(t);
  srv.fault = 'unclosed';
  await assert.rejects(
    download({ fetch, language: 'en', baseUrl: srv.baseUrl, keep: all, timeouts: TIMEOUTS }),
    (err) => err.kind === 'format' && /cut short/.test(err.message),
  );
});

test('the number of sheets read is bounded', async (t) => {
  const srv = await server(t);
  const result = await download({
    fetch,
    language: 'en',
    baseUrl: srv.baseUrl,
    keep: all,
    maxRecords: 50,
    timeouts: TIMEOUTS,
  });
  assert.equal(result.nids.length, 50);
  assert.equal(result.truncated, true);
});

test('stop() gives up a download that stalls at once', async (t) => {
  const srv = await server(t);
  srv.fault = 'stall';
  const world = await createWorld(t, { server: srv });
  world.app.monitor.sourceTimeouts = { headers: 60000, stall: 60000, total: 600000 };
  const cycle = world.monitor.runCycle();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = performance.now();
  await world.app.stop();
  await cycle;
  assert.ok(performance.now() - started < 2000, `stopped in ${performance.now() - started} ms`);
});

// --- monitor.js: pauses ---------------------------------------------------------

async function pauseOf(t, status, retryAfter) {
  const dataDir = await tempDir(t);
  const world = await createWorld(t, { dataDir });
  world.server.fault = status;
  world.server.retryAfter = retryAfter;
  await tick(world, 1);
  const data = await readData(dataDir);
  return { pause: data.pauseUntil - data.attemptAt, world };
}

test('a pause asked by the server is at least 1 minute', async (t) => {
  const { pause } = await pauseOf(t, 503, 5);
  assert.ok(Math.abs(pause - MINUTE) < 1000, `${pause}`);
});

test('a pause asked by the server is at most 6 hours', async (t) => {
  const { pause } = await pauseOf(t, 503, 100000);
  assert.ok(Math.abs(pause - 6 * HOUR) < 1000, `${pause}`);
});

test('a 429 is a pause too, Retry-After honoured', async (t) => {
  const { pause, world } = await pauseOf(t, 429, 7200);
  assert.ok(Math.abs(pause - 2 * HOUR) < 1000, `${pause}`);
  world.server.fault = false;
  const requests = world.server.requests.length;
  await tick(world, 2 * HOUR - MINUTE);
  assert.equal(world.server.requests.length, requests);
});

test('a change of language waits for the end of a pause', async (t) => {
  const { world } = await pauseOf(t, 503, 3600);
  world.server.fault = false;
  await world.fake.configUpdated({ ...world.fake.config, language: 'en' });
  await tick(world, 50 * MINUTE);
  assert.equal(world.server.count(FILE_EN), 0);
  await tick(world, 11 * MINUTE);
  assert.equal(world.server.count(FILE_EN), 1);
});

// --- monitor.js: what is kept and fired -----------------------------------------

test('the sheets kept are bounded, the status says it', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' }, limits: { maxKept: 5 } });
  await tick(world, 1);
  assert.equal(world.monitor.records.length, 5);
  assert.match(world.fake.connectionStatus.message.en, /more sheets than the integration reads/);
});

test('a word matches whole words only ("maple" is not "Maplewood")', async (t) => {
  const world = await createWorld(t, { config: { language: 'en', keywords: 'maple' } });
  await tick(world, 1);
  await create(world);
  world.server.publish(
    newRecord(98000, { Title: 'Maplewood brand crackers recalled', Product: 'Crackers' }),
  );
  world.server.publish(newRecord(98001, { Title: 'Maple syrup recalled', Product: 'Syrup' }));
  await tick(world, 6 * HOUR);
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => (e.data ?? e).title),
    ['Maple syrup recalled'],
  );
});

test('a refused event of an undated sheet stays pending, never known, through a new file', async (t) => {
  const dataDir = await tempDir(t);
  const world = await createWorld(t, { dataDir, config: { language: 'en' } });
  await tick(world, 1);
  world.server.publish(newRecord(98100, { 'Last updated': null }));
  const original = world.gladys.publishSceneEvent.bind(world.gladys);
  world.gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 503');
  };
  await tick(world, 6 * HOUR);
  let data = await readData(dataDir);
  assert.deepEqual(data.pending, ['98100']);
  assert.ok(!data.known.includes('98100'));
  // A newer file still holding it: the event leaves then.
  world.gladys.publishSceneEvent = original;
  world.server.touch('Thu, 29 Oct 2026 10:00:00 GMT');
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  data = await readData(dataDir);
  assert.deepEqual(data.pending, []);
  assert.ok(data.known.includes('98100'));
});

test('a 304 for a copy no longer kept is a failure, nothing published', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  world.server.fault = 'force304';
  await tick(world, 1);
  await create(world);
  assert.deepEqual(world.fake.states, []);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /not modified/);
});

test('an older CDN edge: the next checks send only the date, and get a 304', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  // An edge serves an older file under another ETag.
  world.server.touch('Wed, 28 Oct 2026 02:14:00 GMT');
  await tick(world, 6 * HOUR);
  assert.equal(world.server.requests.at(-1).headers['if-none-match'], '"fake-en-1"');
  await tick(world, 6 * HOUR);
  const last = world.server.requests.at(-1);
  assert.equal(last.headers['if-none-match'], undefined);
  assert.equal(last.headers['if-modified-since'], 'Thu, 29 Oct 2026 02:14:39 GMT');
  assert.equal(world.server.count(FILE_EN), 3);
  assert.equal(world.monitor.error, null);
});

// --- store.js ------------------------------------------------------------------

test('an oversized /data file is set aside; a state too large keeps its NIDs, drops the copies', async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    join(dir, FILE_NAME),
    JSON.stringify({ version: 1, known: ['1'], pad: 'x'.repeat(5000) }),
  );
  const store = new Store(dir, { maxFileBytes: 1000 });
  const { data, unreadable } = await store.load();
  assert.equal(data, null);
  assert.equal(unreadable, true);
  assert.ok((await readdir(dir)).includes(`${FILE_NAME}.bad`));
  const known = Array.from({ length: 50 }, (_, i) => String(i));
  await store.save({ version: 1, known, copy: { records: ['x'.repeat(2000)] }, otherCopy: null });
  const written = await readData(dir);
  assert.deepEqual(written.known, known);
  assert.equal(written.copy, null);
});

test('writes are atomic: through a temporary file renamed, none left behind', async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir);
  assert.equal(await store.save({ version: 1, known: ['1'] }), true);
  assert.deepEqual(await readdir(dir), [FILE_NAME]);
  assert.deepEqual((await readData(dir)).known, ['1']);
});

// --- config.js ------------------------------------------------------------------

test(`at most ${MAX_KEYWORDS} words are followed`, () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(', ');
  assert.equal(parseKeywords(words).length, MAX_KEYWORDS);
});

// --- app.js ---------------------------------------------------------------------

test('getConfig() retried 5 s, then doubled, capped at 5 minutes', async (t) => {
  const gladys = createFakeGladys({ config: {} });
  const clock = testClock({ start: START });
  const times = [];
  gladys.getConfig = async () => {
    times.push(clock.monotonic());
    throw new Error('ECONNRESET');
  };
  const world = await createWorld(t, { gladys, clock, connect: false });
  // The SDK's own read while connecting fails too: the connection goes on
  // retrying; the integration's handler is driven directly.
  gladys.emit('connected');
  await idle(world);
  for (let i = 0; i < 9; i += 1) {
    await tick(world, CONFIG_RETRY_MAX_MS);
  }
  const gaps = times.slice(1).map((at, i) => Math.round((at - times[i]) / 1000) * 1000);
  assert.deepEqual(gaps.slice(0, 7), [
    CONFIG_RETRY_MS,
    2 * CONFIG_RETRY_MS,
    4 * CONFIG_RETRY_MS,
    8 * CONFIG_RETRY_MS,
    16 * CONFIG_RETRY_MS,
    32 * CONFIG_RETRY_MS,
    CONFIG_RETRY_MAX_MS,
  ]);
});

test('a configuration read for an older connection is dropped', async (t) => {
  const gladys = createFakeGladys({ config: { language: 'en' } });
  let release;
  let calls = 0;
  const original = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2) {
      // The read of the first `connected`: slow, and with an older language.
      await new Promise((resolve) => {
        release = resolve;
      });
      return { language: 'fr' };
    }
    return original();
  };
  const world = await createWorld(t, { gladys, connect: false });
  const first = gladys.connect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // A newer `connected` (reconnection) reads the current configuration.
  gladys.emit('connected');
  await world.app.ready;
  release();
  await first;
  await idle(world);
  assert.equal(world.monitor.config.language, 'en');
  assert.equal(featureId(gladys.fake.discoveredDevices[0], 'recalls_week').length > 0, true);
  assert.equal(world.server.count(FILE_FR), 0);
});

test('the sheets never seen are kept apart, bounded too', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' }, limits: { maxNewKept: 1 } });
  await tick(world, 1);
  world.server.publish(newRecord(98200));
  world.server.publish(newRecord(98201));
  world.server.publish(newRecord(98202));
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  assert.match(world.fake.connectionStatus.message.en, /more sheets than the integration reads/);
});
