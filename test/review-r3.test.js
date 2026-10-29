// Review r3: the configuration read at a reconnection (I5), and the minor
// survivors of its mutants (R8, R12, R14, R15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate } from '../src/messages.js';
import { MAX_PENDING, sanitize } from '../src/monitor.js';
import { FILE_EN } from './helpers/server.js';
import { HOUR, START, create, createWorld, featureId, idle, tick } from './helpers/world.js';

const week = (world) => featureId(world.fake.discoveredDevices[0], 'recalls_week');

test('a reconnection applies the configuration changed while Gladys was away', async (t) => {
  const world = await createWorld(t, {
    config: { language: 'en', refresh_interval: '24', keywords: '' },
  });
  await tick(world, 1);
  await create(world);
  assert.equal(world.fake.lastState(week(world)), 12);
  await world.gladys.disconnect();
  // Changed while the integration was disconnected: no onConfigUpdated, only
  // the getConfig() of the reconnection carries it.
  world.fake.config = { ...world.fake.config, refresh_interval: '12', keywords: 'maple' };
  await world.gladys.connect();
  await idle(world);
  assert.equal(world.monitor.config.refreshHours, 12);
  assert.deepEqual(world.monitor.config.keywords, ['maple']);
  // The selection follows the keyword (no sheet of the file names "maple").
  assert.equal(world.fake.lastState(week(world)), 0);
  // The next check follows the new interval (12 h after the last one), not 24 h.
  const requests = world.server.count(FILE_EN);
  await tick(world, 12 * HOUR - 1000);
  assert.equal(world.server.count(FILE_EN), requests);
  await tick(world, 2000);
  assert.equal(world.server.count(FILE_EN), requests + 1);
});

test('the warning after a failed check gives the time of the last good reading', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  await create(world);
  world.server.fault = 503;
  await tick(world, 6 * HOUR);
  assert.equal(world.monitor.freshness(), 'fresh');
  const readAt = { en: formatDate(START, 'en'), fr: formatDate(START, 'fr') };
  // The failed check is 6 h later: another time, which the warning never gives.
  const failedAt = formatDate(world.clock.now(), 'en');
  assert.notEqual(failedAt, readAt.en);
  const scene = await world.fake.sceneAction('read_recalls', {});
  assert.equal(scene.success, true);
  assert.ok(
    scene.data.outputs.text.startsWith('Warning: the last check of the file failed'),
    scene.data.outputs.text,
  );
  assert.ok(
    scene.data.outputs.text.includes(`; the recalls are those read on ${readAt.en}.`),
    scene.data.outputs.text,
  );
  assert.ok(!scene.data.outputs.text.includes(failedAt), scene.data.outputs.text);
  const action = await world.fake.action('check_now', {});
  assert.ok(
    action.data.message.fr.includes(` ; les rappels sont ceux lus le ${readAt.fr}.`),
    action.data.message.fr,
  );
});

test('the widget of a file never read: the heading waits, the caption gives only the source', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  assert.equal(world.monitor.freshness(), 'none');
  for (const [language, heading, source] of [
    ['en', 'Waiting for Health Canada…', 'Source: Health Canada'],
    ['fr', 'En attente de Santé Canada…', 'Source : Santé Canada'],
  ]) {
    const { data } = await world.fake.widgetGet('recalls', { language });
    const components = (data.content ?? data).components;
    assert.equal(components[0].text, heading);
    const caption = components.find((c) => c.type === 'text' && c.variant === 'caption');
    assert.equal(caption.text, source);
  }
  // Also after a failed first check: still "waiting", never the error twice.
  world.server.fault = 503;
  await tick(world, 1);
  assert.notEqual(world.monitor.error, null);
  const { data } = await world.fake.widgetGet('recalls', { language: 'en' });
  const components = (data.content ?? data).components;
  assert.equal(components[0].text, 'Waiting for Health Canada…');
  assert.equal(components.find((c) => c.variant === 'caption').text, 'Source: Health Canada');
});

test('a failed check while the recalls are fresh: the counters are still published', async (t) => {
  const world = await createWorld(t, { config: { language: 'en' } });
  await tick(world, 1);
  const device = await create(world);
  world.server.fault = 503;
  await tick(world, 6 * HOUR);
  assert.notEqual(world.monitor.error, null);
  assert.equal(world.monitor.freshness(), 'fresh');
  // The device created again (Gladys forgot its states): published again.
  let before = world.fake.states.length;
  await world.fake.deviceCreated(device);
  await idle(world);
  assert.equal(world.fake.states.length, before + 2);
  assert.equal(world.fake.lastState(week(world)), 12);
  // A Gladys polling anyway gets them too.
  world.gladys.forgetPublishedStates();
  before = world.fake.states.length;
  await world.fake.poll(device);
  await idle(world);
  assert.equal(world.fake.states.length, before + 2);
  assert.equal(world.fake.lastState(week(world)), 12);
});

test('events waiting in /data: 500 at most are taken back, the newest', () => {
  const nids = Array.from({ length: MAX_PENDING + 100 }, (_, i) => String(80000 + i));
  const out = sanitize({ pending: [...nids, 'not a NID', 12] });
  assert.equal(out.pending.length, MAX_PENDING);
  assert.deepEqual(out.pending, nids.slice(-MAX_PENDING));
});
