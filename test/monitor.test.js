// The monitor end to end: fake Gladys, fake Health Canada server, virtual clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { FILE_NAME, Store } from '../src/store.js';
import { MAX_EVENTS_PER_CYCLE } from '../src/monitor.js';
import { testClock } from './kit/clock.mjs';
import { FILE_EN, FILE_FR, newRecord, startServer } from './helpers/server.js';
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
const latest = (world) => featureId(world.fake.discoveredDevices[0], 'latest_recall');
const readData = async (world) =>
  JSON.parse(await readFile(join(world.dataDir, FILE_NAME), 'utf8'));

/** A world whose first check is done and whose device is created. */
async function ready(t, options = {}) {
  const world = await createWorld(t, options);
  await tick(world, 1);
  await create(world);
  return world;
}

test('first start: one download, nothing fired, the counters from the file', async (t) => {
  const world = await ready(t, { config: { language: 'en' } });
  assert.equal(world.server.count(FILE_EN), 1);
  assert.equal(world.server.count(FILE_FR), 0);
  assert.deepEqual(world.fake.sceneEvents, []);
  // 12 sheets of the default categories, not archived, updated from 23/10 (see the fixture).
  assert.equal(world.fake.lastState(week(world)), 12);
  assert.match(world.fake.lastState(latest(world)), /^Oct 27 · Buck Wild brand/);
  const status = world.fake.connectionStatus;
  assert.equal(status.connected, true);
  const data = await readData(world);
  assert.equal(data.known.length, world.server.records.en.length);
  assert.equal(data.copy.etag, '"fake-en-1"');
});

test('a new sheet fires new_recall once; a restart and an unchanged file fire nothing', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  const world = await ready(t, { server, dataDir, config: { language: 'en' } });
  server.publish(newRecord(90001));
  // Nothing before the interval (6 h by default).
  await tick(world, 5 * HOUR);
  assert.equal(server.count(FILE_EN), 1);
  await tick(world, HOUR);
  assert.equal(server.count(FILE_EN), 2);
  assert.equal(world.fake.sceneEvents.length, 1);
  const [event] = world.fake.sceneEvents;
  assert.equal(event.key ?? event.trigger_key ?? event.trigger, 'new_recall');
  const data = event.data ?? event;
  assert.equal(data.category, 'food');
  assert.equal(data.recall_class, 'Class 1');
  assert.match(data.summary, /^Recall in Canada: Test brand Maple Cookies/);
  assert.match(data.url, /^https:\/\/recalls-rappels\.canada\.ca\/en\//);
  assert.equal(world.fake.lastState(week(world)), 13);
  // Unchanged file: 304, nothing fired again.
  await tick(world, 6 * HOUR);
  assert.equal(server.count(FILE_EN), 3);
  assert.equal(server.requests.at(-1).headers['if-none-match'], server.etag('en'));
  assert.equal(world.fake.sceneEvents.length, 1);
  // Restart on the same /data, 1 h later: the check 5 h later is a 304
  // answered from the copy, nothing fired.
  await world.app.stop();
  const clock = testClock({ start: world.clock.now() + HOUR });
  const again = await createWorld(t, {
    server,
    dataDir,
    clock,
    config: { language: 'en' },
    devices: world.fake.devices,
  });
  await tick(again, 5 * HOUR - 1000);
  assert.equal(server.count(FILE_EN), 3);
  await tick(again, 1000);
  assert.equal(server.count(FILE_EN), 4);
  assert.equal(server.requests.at(-1).headers['if-none-match'], server.etag('en'));
  assert.deepEqual(again.fake.sceneEvents, []);
  // 01:00 on 30/10 in Toronto: the window is now 24/10-30/10, the three
  // sheets of 23/10 left it.
  assert.equal(again.fake.lastState(week(world)), 10);
});

test('a new sheet out of the selection, archived or older than 7 days fires nothing', async (t) => {
  const world = await ready(t, { config: { language: 'en', keywords: 'maple' } });
  world.server.publish(newRecord(90002, { Title: 'Other cookies recalled', Product: 'Cookies' }));
  world.server.publish(newRecord(90003, { Archived: '1' }));
  world.server.publish(newRecord(90004, { 'Last updated': '2026-10-01' }));
  world.server.publish(newRecord(90005, { Organization: 'Medical devices' }));
  world.server.publish(newRecord(90006, { 'Last updated': null }));
  await tick(world, 6 * HOUR);
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => (e.data ?? e).title),
    ['Test brand Maple Cookies recalled due to undeclared peanut (90006)'],
  );
  // The keyword keeps only the sheets naming "maple" (none in the real file).
  assert.equal(world.fake.lastState(week(world)), 0);
  assert.equal(world.fake.lastState(latest(world)), 'No recall in the last 7 days');
});

test('a scene event Gladys refuses is kept (in /data) and sent at the next check', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  const world = await ready(t, { server, dataDir, config: { language: 'en' } });
  server.publish(newRecord(90010));
  const original = world.gladys.publishSceneEvent.bind(world.gladys);
  world.gladys.publishSceneEvent = async () => {
    throw new Error('HTTP 503');
  };
  await tick(world, 6 * HOUR);
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.deepEqual((await readData(world)).pending, ['90010']);
  // A restart, then a 304: the pending event is sent then.
  await world.app.stop();
  const again = await createWorld(t, {
    server,
    dataDir,
    clock: testClock({ start: world.clock.now() + 6 * HOUR }),
    config: { language: 'en' },
    devices: world.fake.devices,
  });
  await tick(again, 1);
  assert.equal(server.requests.at(-1).headers['if-none-match'], server.etag('en'));
  assert.equal(again.fake.sceneEvents.length, 1);
  assert.deepEqual((await readData(again)).pending, []);
  assert.ok((await readData(again)).known.includes('90010'));
  world.gladys.publishSceneEvent = original;
});

test(`at most ${MAX_EVENTS_PER_CYCLE} events a check, the rest at the next one`, async (t) => {
  const world = await ready(t, { config: { language: 'en' } });
  for (let i = 0; i < 25; i += 1) {
    world.server.publish(newRecord(91000 + i));
  }
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, MAX_EVENTS_PER_CYCLE);
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 25);
  const nids = world.fake.sceneEvents.map((e) => (e.data ?? e).title.match(/\((\d+)\)/)[1]);
  assert.equal(new Set(nids).size, 25, 'each fired once');
});

test('a restart within the interval waits for its rest; a date of /data in the future is ignored', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  const world = await ready(t, { server, dataDir });
  await world.app.stop();
  // 2 h later: the next check is 4 h away.
  const again = await createWorld(t, {
    server,
    dataDir,
    clock: testClock({ start: world.clock.now() + 2 * HOUR }),
    devices: world.fake.devices,
  });
  await tick(again, 4 * HOUR - MINUTE);
  assert.equal(server.count(FILE_FR), 1);
  await tick(again, MINUTE);
  assert.equal(server.count(FILE_FR), 2);
  await again.app.stop();
  // An attempt dated tomorrow: not trusted, the check runs at once.
  const data = await readData(again);
  data.attemptAt = again.clock.now() + 24 * HOUR;
  await writeFile(join(dataDir, FILE_NAME), JSON.stringify(data));
  const third = await createWorld(t, {
    server,
    dataDir,
    clock: testClock({ start: again.clock.now() }),
    devices: world.fake.devices,
  });
  await tick(third, 1);
  assert.equal(server.count(FILE_FR), 3);
});

test('the attempt is written to /data before the request leaves', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  let attemptAtRequest = null;
  const world = await createWorld(t, { server, dataDir });
  const realFetch = world.monitor.fetch;
  world.monitor.fetch = async (...args) => {
    attemptAtRequest = JSON.parse(await readFile(join(dataDir, FILE_NAME), 'utf8')).attemptAt;
    return realFetch(...args);
  };
  await tick(world, 1);
  assert.ok(Number.isFinite(attemptAtRequest));
});

test('503 with Retry-After: a pause kept in /data and honoured after a restart; no 0 published', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  const world = await ready(t, { server, dataDir, config: { language: 'en' } });
  const before = world.fake.states.length;
  server.fault = 503;
  server.retryAfter = 7200;
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.states.length, before, 'nothing published on a failure');
  const status = world.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.match(JSON.stringify(status), /HTTP 503/);
  assert.match(JSON.stringify(status), /next try at/);
  const data = await readData(world);
  assert.ok(data.pauseUntil > world.clock.now() + HOUR);
  await world.app.stop();
  server.fault = false;
  const again = await createWorld(t, {
    server,
    dataDir,
    clock: testClock({ start: world.clock.now() + 30 * MINUTE }),
    config: { language: 'en' },
    devices: world.fake.devices,
  });
  const count = server.count(FILE_EN);
  await tick(again, 85 * MINUTE);
  assert.equal(server.count(FILE_EN), count, 'still paused');
  await tick(again, 10 * MINUTE);
  assert.equal(server.count(FILE_EN), count + 1);
  assert.equal(again.fake.connectionStatus.connected, true);
});

test('a network failure retries after 15 min, then 30, never faster', async (t) => {
  const world = await ready(t);
  world.server.fault = 'drop';
  await tick(world, 6 * HOUR);
  const after = world.server.requests.length;
  await tick(world, 14 * MINUTE);
  assert.equal(world.server.requests.length, after);
  await tick(world, MINUTE);
  assert.equal(world.server.requests.length, after + 1);
  await tick(world, 29 * MINUTE);
  assert.equal(world.server.requests.length, after + 1);
  await tick(world, MINUTE);
  assert.equal(world.server.requests.length, after + 2);
});

test('a stale file (unchanged for 4 days by the Date header) is said, and its counters not published', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.date = () => 'Mon, 02 Nov 2026 16:00:00 GMT';
  const world = await createWorld(t, { server, config: { language: 'en' } });
  await tick(world, 1);
  await create(world);
  assert.equal(world.fake.lastState(week(world)), undefined);
  assert.match(JSON.stringify(world.fake.connectionStatus), /has not changed since Oct 29/);
  // Regenerated: the counters come back.
  server.touch('Mon, 02 Nov 2026 02:14:00 GMT');
  await tick(world, 6 * HOUR);
  assert.equal(typeof world.fake.lastState(week(world)), 'number');
});

test('without a Date header the file is never said to be stale', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.date = () => null;
  server.lastModified = 'Thu, 01 Jan 2026 00:00:00 GMT';
  const world = await ready(t, { server });
  assert.equal(world.monitor.sourceStale, false);
  assert.equal(typeof world.fake.lastState(week(world)), 'number');
});

test('getConfig() failing in `connected` is tried again until it works, status said', async (t) => {
  const gladys = createFakeGladys({ config: { language: 'en' } });
  // The SDK reads the configuration itself while connecting (call 1); the
  // integration then reads it in `connected`: calls 2 and 3 fail.
  let calls = 0;
  const failing = new Set([2, 3]);
  const original = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (failing.has(calls)) {
      throw new Error('ECONNRESET');
    }
    return original();
  };
  const world = await createWorld(t, { gladys, connect: false });
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(JSON.stringify(gladys.fake.connectionStatus), /configuration/);
  assert.deepEqual(gladys.fake.discoveredDevices, []);
  await tick(world, 5000);
  assert.deepEqual(gladys.fake.discoveredDevices, [], 'second failure');
  await tick(world, 10000);
  // The start reads /data (real I/O): wait for it.
  await world.app.ready;
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  await tick(world, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // At a reconnection too.
  failing.add(calls + 2);
  await gladys.disconnect();
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await tick(world, 5000);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a reconnection republishes the fresh states, never downloads again', async (t) => {
  const world = await ready(t);
  const requests = world.server.requests.length;
  await world.gladys.disconnect();
  await world.gladys.connect();
  await idle(world);
  assert.equal(world.server.requests.length, requests);
  assert.equal(world.fake.lastState(week(world)), 12);
});

test('nothing old is republished: no state after a restart before a check, none from a check too old', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  const world = await ready(t, { server, dataDir });
  await world.app.stop();
  const again = await createWorld(t, {
    server,
    dataDir,
    clock: testClock({ start: world.clock.now() + HOUR }),
    devices: world.fake.devices,
  });
  await again.fake.deviceCreated(world.fake.devices[0]);
  assert.deepEqual(again.fake.states, [], 'the copy of /data is not published before a check');
  // The widget shows the copy meanwhile.
  const widget = await again.fake.widgetGet('recalls', { language: 'fr' });
  assert.match(JSON.stringify(widget), /12 rappels sur 7 jours/);
});

test('a change of language reads the other file, fires nothing, and not twice in 5 minutes', async (t) => {
  const world = await ready(t, { config: { language: 'en' } });
  await world.fake.configUpdated({ ...world.fake.config, language: 'fr' });
  await tick(world, 5 * MINUTE);
  assert.equal(world.server.count(FILE_FR), 1);
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.match(world.fake.lastState(latest(world)), /^27 oct\. · /);
  await world.fake.configUpdated({ ...world.fake.config, language: 'en' });
  await tick(world, 4 * MINUTE);
  assert.equal(world.server.count(FILE_EN), 1, 'not yet');
  await tick(world, MINUTE + 1);
  assert.equal(world.server.count(FILE_EN), 2);
  // The copy of the first file was replaced: read in full (no 304 for another copy).
  assert.equal(world.server.requests.at(-1).headers['if-none-match'], undefined);
});

test('a change of the selection is applied from the copy, without a download', async (t) => {
  const world = await ready(t, { config: { language: 'en' } });
  const requests = world.server.requests.length;
  await world.fake.configUpdated({ ...world.fake.config, categories: ['vehicles'] });
  await idle(world);
  assert.equal(world.server.requests.length, requests);
  assert.equal(world.fake.lastState(week(world)), 5);
  await world.fake.configUpdated({ ...world.fake.config, categories: [] });
  assert.equal(world.fake.lastState(week(world)), 0);
  assert.match(JSON.stringify(world.fake.connectionStatus), /No category selected/);
});

test('/data that is not JSON is moved aside; /data that cannot be read is never written', async (t) => {
  const dataDir = await tempDir(t);
  await writeFile(join(dataDir, FILE_NAME), '{"version":1,"known":[');
  const world = await ready(t, { dataDir });
  assert.match(await readFile(join(dataDir, `${FILE_NAME}.bad`), 'utf8'), /known/);
  assert.ok((await readData(world)).known.length > 0);

  const lockedDir = await tempDir(t);
  // A directory in place of the file: reading fails with EISDIR, not ENOENT.
  await mkdir(join(lockedDir, FILE_NAME));
  const store = new Store(lockedDir);
  const locked = await ready(t, { dataDir: lockedDir, store });
  assert.equal(store.writable, false);
  assert.match(JSON.stringify(locked.fake.connectionStatus), /cannot be read/);
  assert.deepEqual(locked.fake.sceneEvents, []);
  await chmod(lockedDir, 0o700);
});

test('the actions answer from memory and never download', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  const before = await world.fake.sceneAction('read_recalls', {});
  assert.equal(before.success, false);
  assert.match(before.error, /not been read yet/);
  await tick(world, 1);
  const requests = world.server.requests.length;
  const scene = await world.fake.sceneAction('read_recalls', {});
  assert.equal(scene.success, true);
  assert.equal(scene.data.outputs.count, 12);
  assert.match(scene.data.outputs.text, /^12 recalls or alerts in 7 days: Buck Wild brand/);
  const action = await world.fake.action('check_now', {});
  assert.match(action.data.message.en, /File read at/);
  assert.match(action.data.message.fr, /^12 rappels ou avis sur 7 jours/);
  assert.equal(world.server.requests.length, requests);
});

test('the widget lists the latest recalls, the serious ones in red', async (t) => {
  const world = await ready(t, { config: { language: 'en' } });
  const { data } = await world.fake.widgetGet('recalls', { language: 'en' });
  const content = data.content ?? data;
  const [heading, list, caption, button] = content.components;
  assert.equal(heading.text, '12 recalls in 7 days');
  assert.equal(list.items.length, 8);
  assert.match(list.items[0].title, /^Buck Wild/);
  assert.match(caption.text, /^Source: Health Canada · /);
  assert.equal(button.link.url, 'https://recalls-rappels.canada.ca/en');
  const plantropy = (await world.fake.widgetGet('recalls', { language: 'fr' })).data;
  assert.ok(JSON.stringify(plantropy).length > 0);
  world.monitor.reselect();
  const serious = world.monitor.recalls.find((r) => r.recallClass === 'Class 1');
  const { itemOf } = await import('../src/widgets.js');
  assert.equal(itemOf(serious, 'en').badge.color, 'danger');
});

test('an older file served again by the CDN is not taken, and never fires a recall twice', async (t) => {
  const world = await ready(t, { config: { language: 'en' } });
  world.server.publish(newRecord(96000));
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  // An edge serves the file of the day before (without the new sheet).
  const record = world.server.records.en.shift();
  world.server.records.fr.shift();
  world.server.touch('Wed, 28 Oct 2026 02:14:00 GMT');
  await tick(world, 6 * HOUR);
  // The copy kept is used: the new sheet is still the latest (midnight in
  // Toronto has passed, the sheets of 23/10 left the window).
  assert.equal(world.fake.lastState(week(world)), 10);
  assert.match(world.fake.lastState(latest(world)), /Maple Cookies/);
  // The new file again, with a new ETag: nothing fired again.
  world.server.records.en.unshift(record);
  world.server.touch('Thu, 29 Oct 2026 03:00:00 GMT');
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  assert.ok((await readData(world)).known.includes('96000'));
});

test('a sheet removed from the file then back never fires twice', async (t) => {
  const world = await ready(t, { config: { language: 'en' } });
  world.server.publish(newRecord(97000));
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.sceneEvents.length, 1);
  // A newer file without it (withdrawn), then a newer one with it again.
  const record = world.server.records.en.shift();
  const french = world.server.records.fr.shift();
  world.server.touch('Thu, 29 Oct 2026 10:00:00 GMT');
  await tick(world, 6 * HOUR);
  world.server.records.en.unshift(record);
  world.server.records.fr.unshift(french);
  world.server.touch('Thu, 29 Oct 2026 12:00:00 GMT');
  await tick(world, 6 * HOUR);
  assert.equal(world.server.count(FILE_EN), 4);
  assert.equal(world.fake.sceneEvents.length, 1);
});

test('a reconnection long after the last successful check republishes nothing', async (t) => {
  const world = await ready(t);
  world.server.fault = 'drop';
  await tick(world, 14 * HOUR);
  const states = world.fake.states.length;
  await world.gladys.disconnect();
  await world.gladys.connect();
  await idle(world);
  assert.equal(world.fake.states.length, states);
  assert.equal(world.fake.connectionStatus.connected, false);
});
