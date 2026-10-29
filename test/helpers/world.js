// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, the fake Health Canada server
// (test/helpers/server.js) read through the real fetch, a virtual clock (wall
// and monotonic, timers), a temporary /data removed after the test, and the
// integration wired on top through registerHandlers.
// -----------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { testClock, settle } from '../kit/clock.mjs';
import { startServer } from './server.js';

process.env.LOG_LEVEL ??= 'silent';
process.env.TZ = 'America/Toronto';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
// 29/10/2026 12:00 in Toronto: the files were regenerated at 02:14 UTC.
export const START = Date.parse('2026-10-29T16:00:00Z');

/** A temporary /data, removed after the test. */
export async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-rappels-canada-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  return dir;
}

/**
 * @param {object} t the test context
 * @param {object} [options]
 */
export async function createWorld(
  t,
  {
    config = {},
    devices = [],
    server,
    clock = testClock({ start: START }),
    dataDir,
    connect = true,
    gladys,
    store,
    timings,
  } = {},
) {
  const srv = server ?? (await startServer());
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'gladys-rappels-canada-')));
  const fake = gladys ?? createFakeGladys({ config, devices });
  const app = registerHandlers(fake, {
    store: store ?? new Store(dir),
    fetch: (...args) => fetch(...args),
    baseUrl: srv.baseUrl,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    timings,
    sourceTimeouts: { headers: 2000, stall: 300, total: 10000 },
  });
  // One hook, in this order: the app stops (its last write lands), then the
  // server and the folder of this world go.
  t.after(async () => {
    await app.stop();
    if (!server) {
      await srv.close();
    }
    if (!dataDir) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });
  const world = {
    gladys: fake,
    fake: fake.fake,
    app,
    monitor: app.monitor,
    server: srv,
    clock,
    dataDir: dir,
  };
  if (connect) {
    await fake.connect();
    await app.ready;
    await idle(world);
  }
  return world;
}

/** Waits for the running check, if any, and lets the promises settle. */
export async function idle(world) {
  for (let i = 0; i < 50; i += 1) {
    await settle(3);
    // A turn of the real timers too: /data is real I/O.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!world.monitor.running) {
      return;
    }
    await world.monitor.running;
  }
}

/** Moves the virtual clock on, then waits for the check it started. */
export async function tick(world, ms) {
  await world.clock.advance(ms);
  await idle(world);
}

/** Create the device in Gladys, as the user would. */
export async function create(world) {
  const [device] = world.fake.discoveredDevices;
  await world.fake.deviceCreated(device);
  await idle(world);
  return device;
}

/** External id of one feature of a device. */
export const featureId = (device, key) =>
  device.features.find((feature) => feature.external_id.endsWith(`:${key}`))?.external_id;
