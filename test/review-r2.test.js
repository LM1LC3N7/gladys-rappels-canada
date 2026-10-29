// Review r2: the guards of the new code (I4), a late configuration of a
// reconnection (m10), the warning after a failed check (m12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MAX_KEPT, MAX_NEW_KEPT, sanitize } from '../src/monitor.js';
import { download } from '../src/source.js';
import { FILE_NAME, Store } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { FILE_EN, newRecord, startServer } from './helpers/server.js';
import {
  HOUR,
  MINUTE,
  create,
  createWorld,
  featureId,
  idle,
  tempDir,
  tick,
} from './helpers/world.js';

const week = (world) => featureId(world.fake.discoveredDevices[0], 'recalls_week');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TIMEOUTS = { headers: 2000, stall: 300, total: 10000 };

test('a configuration whose application fails never blocks the next ones', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  const real = world.gladys.publishDiscoveredDevices.bind(world.gladys);
  let calls = 0;
  world.gladys.publishDiscoveredDevices = async (...args) => {
    calls += 1;
    if (calls === 1) {
      throw new Error('HTTP 500');
    }
    return real(...args);
  };
  await world.fake.configUpdated({ ...world.fake.config, language: 'fr' }).catch(() => {});
  await world.fake.configUpdated({ ...world.fake.config, language: 'en', keywords: 'ford' });
  await idle(world);
  assert.equal(world.monitor.config.language, 'en');
  assert.deepEqual(world.monitor.config.keywords, ['ford']);
  assert.equal(world.fake.discoveredDevices[0].name, 'Recalls in Canada');
});

test('a stale file stays stale after a restart: no counter, the action says why', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.date = () => 'Mon, 02 Nov 2026 16:00:00 GMT';
  const dataDir = await tempDir(t);
  const world = await createWorld(t, { server, dataDir, config: { language: 'en' } });
  await tick(world, 1);
  await create(world);
  await world.app.stop();
  server.fault = 'drop';
  const again = await createWorld(t, {
    server,
    dataDir,
    clock: testClock({ start: world.clock.now() + HOUR }),
    config: { language: 'en' },
    devices: world.fake.devices,
  });
  assert.deepEqual(again.fake.states, []);
  assert.equal(again.monitor.freshness(), 'stale');
  const scene = await again.fake.sceneAction('read_recalls', {});
  assert.equal(scene.success, false);
  assert.match(scene.error, /has not changed since/);
});

test('under size pressure the copy of the other language goes first, the NIDs stay', async (t) => {
  const dir = await tempDir(t);
  const store = new Store(dir, { maxFileBytes: 3000 });
  const known = Array.from({ length: 100 }, (_, i) => String(i));
  const copy = { language: 'en', records: [] };
  await store.save({
    version: 1,
    known,
    copy,
    otherCopy: { language: 'fr', pad: 'x'.repeat(5000) },
  });
  const written = JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8'));
  assert.deepEqual(written.known, known);
  assert.deepEqual(written.copy, copy);
  assert.equal(written.otherCopy, null);
});

function undated(count, dated) {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) =>
      newRecord(70000 + i, { 'Last updated': i < dated ? '2026-10-20' : null }),
    ),
  );
}

test('the format guard: from 100 sheets on, at least half of them dated', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const read = () =>
    download({
      fetch,
      language: 'en',
      baseUrl: srv.baseUrl,
      keep: () => false,
      timeouts: TIMEOUTS,
    });
  srv.raw = { en: undated(99, 0) };
  assert.equal((await read()).nids.length, 99, 'fewer than 100 sheets: not judged');
  srv.raw = { en: undated(100, 49) };
  await assert.rejects(read(), (err) => err.kind === 'format');
  srv.raw = { en: undated(100, 50) };
  assert.equal((await read()).nids.length, 100);
});

test('copies read from /data: never two of the same language, bounded', () => {
  const record = (nid) => ({
    nid: String(nid),
    title: 't',
    product: 'p',
    category: 'food',
    subcategory: 's',
    issue: 'i',
    todo: '',
    recallClass: '',
    url: 'https://recalls-rappels.canada.ca/en/x',
    updated: '2026-10-20',
  });
  const many = Array.from({ length: MAX_KEPT + MAX_NEW_KEPT + 300 }, (_, i) => record(i + 1));
  const out = sanitize({
    copy: { language: 'en', records: many },
    otherCopy: { language: 'en', records: [record(9)] },
  });
  assert.equal(out.copy.records.length, MAX_KEPT + MAX_NEW_KEPT);
  assert.equal(out.otherCopy, null);
});

test('the widget says it waits for a first reading', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  const { data } = await world.fake.widgetGet('recalls', { language: 'en' });
  assert.equal((data.content ?? data).components[0].text, 'Waiting for Health Canada…');
});

test('a download given up by stop() is not recorded as a failure', async (t) => {
  const world = await createWorld(t);
  world.server.fault = 'stall';
  world.monitor.sourceTimeouts = { headers: 60000, stall: 60000, total: 600000 };
  const cycle = world.monitor.runCycle();
  await sleep(100);
  await world.app.stop();
  await cycle;
  assert.equal(world.monitor.error, null);
  assert.doesNotMatch(JSON.stringify(world.fake.connectionStatuses ?? []), /integration stopped/);
});

test('back to a language read before: its copy is fresh at once, with its time', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  await world.fake.configUpdated({ ...world.fake.config, language: 'fr' });
  await tick(world, 5 * MINUTE);
  await world.fake.configUpdated({ ...world.fake.config, language: 'en' });
  // Before any new check of the English file.
  assert.equal(world.server.count(FILE_EN), 1);
  assert.equal(world.monitor.freshness(), 'fresh');
  const scene = await world.fake.sceneAction('read_recalls', {});
  assert.equal(scene.success, true);
  assert.equal(scene.data.outputs.count, 12);
});

test('a late getConfig() of a reconnection never overwrites a configuration saved meanwhile', async (t) => {
  const gladys = createFakeGladys({ config: { language: 'en' } });
  const world = await createWorld(t, { gladys });
  await tick(world, 1);
  const original = gladys.getConfig.bind(gladys);
  let release;
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    const config = structuredClone(await original());
    if (calls === 2) {
      // The read of the integration at the reconnection: late, with EN.
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return config;
  };
  await gladys.disconnect();
  const reconnect = gladys.connect();
  await sleep(20);
  await gladys.fake.configUpdated({ ...gladys.fake.config, language: 'fr' });
  release();
  await reconnect;
  await idle(world);
  assert.equal(world.monitor.config.language, 'fr');
});

test('a failed check while the recalls are still fresh: they come with a warning', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  await create(world);
  world.server.fault = 503;
  await tick(world, 6 * HOUR);
  assert.equal(world.monitor.freshness(), 'fresh');
  const scene = await world.fake.sceneAction('read_recalls', {});
  assert.equal(scene.success, true);
  assert.match(
    scene.data.outputs.text,
    /^Warning: the last check of the file failed \(.*HTTP 503.*\); the recalls are those read on .*\. \d+ recalls or alerts/,
  );
  const action = await world.fake.action('check_now', {});
  assert.match(action.data.message.fr, /^Attention : la dernière vérification du fichier a échoué/);
  const widget = (await world.fake.widgetGet('recalls', { language: 'en' })).data;
  assert.match(JSON.stringify(widget), /last check of the file failed/);
  assert.equal(typeof world.fake.lastState(week(world)), 'number');
});

test('beyond 500 events waiting, the oldest are dropped and the status says it', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  world.gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 503');
  };
  for (const base of [60000, 61000]) {
    for (let i = 0; i < 300; i += 1) {
      world.server.publish(newRecord(base + i));
    }
    await tick(world, 6 * HOUR);
  }
  assert.equal(world.monitor.data.pending.length, 500);
  assert.match(world.fake.connectionStatus.message.en, /more sheets than the integration reads/);
});
