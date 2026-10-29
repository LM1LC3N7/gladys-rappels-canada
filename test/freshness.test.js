// Review r1: the recalls are never given as current when they are not (I1),
// configurations saved back to back (I2), the restart from the copy of /data
// (m1), a new interval kept for a restart (m9), a file of another format (m3),
// human error messages (m8).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILE_NAME } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { startServer } from './helpers/server.js';
import { HOUR, create, createWorld, featureId, idle, tempDir, tick } from './helpers/world.js';

const week = (world) => featureId(world.fake.discoveredDevices[0], 'recalls_week');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function say(world) {
  const scene = await world.fake.sceneAction('read_recalls', {});
  const action = await world.fake.action('check_now', {});
  const widget = (await world.fake.widgetGet('recalls', { language: 'en' })).data;
  const components = (widget.content ?? widget).components;
  return {
    scene,
    action: action.data.message.en,
    heading: components[0].text,
    caption: components.find((c) => c.variant === 'caption').text,
  };
}

test('a stale file: the actions and the widget say it, never a count', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  server.date = () => 'Mon, 02 Nov 2026 16:00:00 GMT';
  const world = await createWorld(t, { server, config: { language: 'en' } });
  await tick(world, 1);
  const { scene, action, heading, caption } = await say(world);
  assert.equal(scene.success, false);
  assert.match(
    scene.error,
    /not up to date: the file of Health Canada has not changed since Oct 29/,
  );
  assert.match(action, /^The recalls are not up to date/);
  assert.doesNotMatch(action, /\d+ recalls/);
  assert.equal(heading, 'Recalls not up to date');
  assert.match(caption, /has not changed since/);
});

test('a copy of /data 9 days old and the source down: "not up to date", never "no recall"', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  const world = await createWorld(t, { server, dataDir, config: { language: 'en' } });
  await tick(world, 1);
  await world.app.stop();
  const path = join(dataDir, FILE_NAME);
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.readAt -= 9 * 24 * HOUR;
  data.attemptAt -= 9 * 24 * HOUR;
  data.nextAt = data.attemptAt + 6 * HOUR;
  await writeFile(path, JSON.stringify(data));
  server.fault = 503;
  const again = await createWorld(t, { server, dataDir, config: { language: 'en' } });
  await tick(again, 1);
  const { scene, action, heading, caption } = await say(again);
  assert.equal(scene.success, false);
  assert.match(scene.error, /not up to date: the file of Health Canada was last read on/);
  assert.match(action, /^The recalls are not up to date/);
  assert.equal(heading, 'Recalls not up to date');
  assert.match(caption, /last read on/);
  assert.deepEqual(again.fake.states, []);
});

test('fresh recalls: the scene action gives them', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  const { scene, heading } = await say(world);
  assert.equal(scene.data.outputs.count, 12);
  assert.equal(heading, '12 recalls in 7 days');
});

test('two configurations saved back to back: the last wins, no false 0 published', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  await create(world);
  assert.equal(world.fake.lastState(week(world)), 12);
  const real = world.gladys.publishDiscoveredDevices.bind(world.gladys);
  let calls = 0;
  world.gladys.publishDiscoveredDevices = async (...args) => {
    calls += 1;
    await sleep(calls === 1 ? 300 : 5);
    return real(...args);
  };
  const first = world.fake.configUpdated({ ...world.fake.config, language: 'fr' });
  await sleep(20);
  const second = world.fake.configUpdated({ ...world.fake.config, language: 'en' });
  await Promise.all([first, second]);
  await idle(world);
  assert.equal(world.monitor.config.language, 'en');
  assert.equal(world.monitor.recalls.length, 12);
  // Applied in order: the device last published carries the English names.
  assert.equal(world.fake.discoveredDevices[0].name, 'Recalls in Canada');
  assert.ok(
    world.fake.states.every((s) => s.state !== 0),
    'no recalls_week = 0 published during the race',
  );
  assert.equal(world.fake.lastState(week(world)), 12);
});

test('a new interval is kept in /data: a restart follows it', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  const world = await createWorld(t, { server, dataDir });
  await tick(world, 1);
  await world.fake.configUpdated({ ...world.fake.config, refresh_interval: '24' });
  await world.app.stop();
  const data = JSON.parse(await readFile(join(dataDir, FILE_NAME), 'utf8'));
  assert.ok(data.nextAt - data.attemptAt >= 24 * HOUR - 1000);
  const again = await createWorld(t, {
    server,
    dataDir,
    clock: testClock({ start: world.clock.now() + 7 * HOUR }),
    config: { refresh_interval: '24' },
  });
  const requests = server.requests.length;
  await tick(again, 16 * HOUR);
  assert.equal(server.requests.length, requests, 'not at the old time (6 h)');
  await tick(again, HOUR + 1000);
  assert.equal(server.requests.length, requests + 1);
});

test('a file whose date column was renamed is refused, never read as "no recall"', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  await create(world);
  const before = world.fake.states.length;
  world.server.raw = {
    en: JSON.stringify(world.server.records.en).replaceAll('"Last updated"', '"Updated on"'),
  };
  world.server.touch();
  await tick(world, 6 * HOUR);
  assert.equal(world.fake.states.length, before);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /not in the expected format/);
});

test('the status says what failed in words, never a raw code', async (t) => {
  const world = await createWorld(t);
  world.server.fault = 'drop';
  await tick(world, 1);
  const { message } = world.fake.connectionStatus;
  assert.match(message.en, /connection (failed|was cut by the server)/);
  assert.match(message.fr, /connexion (a échoué|a été coupée par le serveur)/);
  assert.doesNotMatch(JSON.stringify(message), /UND_ERR|ECONN|fetch failed|127\.0\.0\.1/);
  assert.equal(world.server.requests.length, 1);
});

test('a time of /data in the future is not trusted: nothing published from it', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const dataDir = await tempDir(t);
  const world = await createWorld(t, { server, dataDir });
  await tick(world, 1);
  await create(world);
  await world.app.stop();
  const path = join(dataDir, FILE_NAME);
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.readAt += 24 * HOUR;
  await writeFile(path, JSON.stringify(data));
  server.fault = 'drop';
  const again = await createWorld(t, { server, dataDir, devices: world.fake.devices });
  assert.deepEqual(again.fake.states, []);
  assert.equal(again.monitor.freshness(), 'old');
});

test('a language changed during a download: the file of the old language is not taken', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  world.server.fault = 'slow';
  world.server.slowMs = 100;
  const cycle = world.monitor.runCycle();
  await sleep(50);
  await world.fake.configUpdated({ ...world.fake.config, language: 'fr' });
  await cycle;
  assert.equal(world.monitor.config.language, 'fr');
  assert.ok(world.monitor.records.every((r) => r.url.includes('/fr/')));
  assert.notEqual(world.monitor.data.copy?.language, 'en');
});
