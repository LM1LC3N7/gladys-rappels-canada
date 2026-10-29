// The period of the checks on the real clock sped up 20 times (one "hour" of
// the interval shortened to 3 s): never faster than the interval, never a
// cycle late. And the schedule runs on the monotonic clock: a wall clock moved
// by NTP neither hastens nor delays a check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurePeriod, realClock, spyOn, testClock } from './kit/clock.mjs';
import { HOUR, START, createWorld, tick } from './helpers/world.js';

test('real clock x20: one check per interval, measured', async (t) => {
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const world = await createWorld(t, {
    clock,
    config: { refresh_interval: '3' },
    timings: { hourMs: 3000 },
  });
  const spy = spyOn(world.monitor, 'runCycle', clock);
  const gaps = await measurePeriod(spy, { count: 4, period: 9000, max: 9000 * 1.8 });
  assert.equal(gaps.length, 3);
  assert.ok(world.server.requests.length >= 3);
});

test('the wall clock jumping 6 h does not start a check early', async (t) => {
  const base = testClock({ start: START });
  let jump = 0;
  const clock = {
    ...base,
    now: () => base.now() + jump,
    timers: base.timers,
    advance: base.advance,
  };
  const world = await createWorld(t, { clock });
  await tick(world, 1);
  const requests = world.server.requests.length;
  jump = 6 * HOUR;
  await tick(world, HOUR);
  assert.equal(world.server.requests.length, requests);
  await tick(world, 5 * HOUR);
  assert.equal(world.server.requests.length, requests + 1);
});
