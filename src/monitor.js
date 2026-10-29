// -----------------------------------------------------------------------------
// The monitor: checks the open data file of Health Canada every
// `refresh_interval` hours (a conditional GET: 304 while the file is the same,
// the full file once a day), keeps the sheets of the followed selection,
// publishes the states of the device, fires the scene trigger and serves the
// widget and the actions.
//
// Selection: a sheet not archived, of a followed category and, when brands or
// words are given, naming one of them (title, product or category).
//
// Trigger `new_recall`: a NID absent from the previous file, in the selection,
// whose "last updated" day is within the last 7 days (or unknown). Every NID of
// the file is remembered, in the selection or not: widening the selection
// later fires nothing for the sheets already published. An updated sheet (same
// NID) is not a new recall. The first file ever read fires nothing: what is
// listed then is not news. What was seen is kept under /data, so a restart
// fires nothing again; a scene event Gladys refused, or one beyond the cap of a
// cycle, stays pending (in /data too) and is sent at the next check. An event
// is sent before /data records it: a crash in between sends it again (at least
// once, never lost).
//
// Freshness: the values (states, actions, widget) come from a check less than
// two intervals and an hour old, of a file that is not stale; otherwise they
// say they are not up to date and the counters are not published. A restart
// takes the copy of /data with the time it was read.
//
// Configurations saved back to back are applied one by one, in order: the last
// one wins.
//
// Clocks: the schedule runs on the monotonic clock (a wall clock moved by NTP
// neither hastens nor delays a check); the wall clock dates the days of the
// sheets, and the attempt kept in /data so a restart never checks faster than
// the interval.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { fold } from './config.js';
import { buildDevice, deviceIds } from './device.js';
import {
  CATEGORY_NAMES,
  PHRASES,
  STATUS,
  clip,
  dayBefore,
  describe,
  describeError,
  formatDate,
  formatSourceDay,
  formatTime,
  join,
  localDay,
  render,
  renderEach,
} from './messages.js';
import { BASE_URL, MAX_RECORDS, download, httpDate } from './source.js';

const logger = createLogger({ name: 'rappels-canada' });

export const WIDGET_KEY = 'recalls';
export const TRIGGERS = { NEW: 'new_recall' };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_TIMINGS = {
  // One hour of the refresh interval (shortened by the real-clock test only).
  hourMs: HOUR,
  heartbeatMs: 12 * HOUR,
  // requestWidgetRefresh is rate-limited to one call every 10 s by the core.
  widgetRefreshMs: 10 * SECOND,
  // First retry after a failure; doubled each time, up to the interval.
  retryMs: 15 * MINUTE,
  // Bounds of a pause asked by the server (Retry-After) or after a 429/5xx.
  minPauseMs: MINUTE,
  maxPauseMs: 6 * HOUR,
  // A change of language reads the other file, but not twice in 5 minutes.
  languageChangeMs: 5 * MINUTE,
};

// The file is regenerated every day: unchanged for 3 days, it is stale.
export const STALE_MS = 3 * DAY;
// Sheets kept from the file: those updated in the last 30 days (about 200 on
// 29/10/2026), 1,500 at most, plus the sheets never seen before, 500 at most.
// Two copies (one per language) of 2,000 sheets of 2.5 KB at most and 250,000
// NIDs stay under the 16 MB of /data (src/store.js).
export const KEEP_DAYS = 30;
export const MAX_KEPT = 1500;
export const MAX_NEW_KEPT = 500;
// The device counts the sheets of the last 7 days (today and the 6 before).
export const WEEK_DAYS = 7;
// A new NID older than this ("last updated") is remembered, never fired.
export const FIRE_DAYS = 7;
// Scene events fired by one check at most: the core takes 300 a minute.
export const MAX_EVENTS_PER_CYCLE = 20;
export const MAX_PENDING = 500;
export const MAX_KNOWN = 250000;
// Texts of the scene variables (the core takes 1000 characters).
const MAX_VARIABLE = 500;

const newestFirst = (a, b) =>
  (b.updated ?? '').localeCompare(a.updated ?? '') || Number(b.nid) - Number(a.nid);

export class Monitor {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK fake)
   * @param {object} options.store see src/store.js
   * @param {Function} [options.fetch] fetch
   * @param {string} [options.baseUrl] where the files are read (tests)
   * @param {Function} [options.now] wall clock in ms
   * @param {Function} [options.monotonic] monotonic clock in ms
   * @param {object|false} [options.timers] { setTimeout, clearTimeout }; false: no timer
   * @param {object} [options.timings] overrides of DEFAULT_TIMINGS
   * @param {object} [options.sourceTimeouts] overrides of the download timeouts
   * @param {object} [options.limits] overrides of maxKept, maxNewKept, maxRecords (tests)
   */
  constructor({
    gladys,
    store,
    fetch: fetchImpl,
    baseUrl = BASE_URL,
    now,
    monotonic,
    timers,
    timings,
    sourceTimeouts,
    limits,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.fetch = fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = baseUrl;
    this.now = now ?? (() => Date.now());
    this.monotonic = monotonic ?? (() => performance.now());
    this.timers = timers === undefined ? { setTimeout, clearTimeout } : timers;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.sourceTimeouts = sourceTimeouts;
    this.limits = {
      maxKept: MAX_KEPT,
      maxNewKept: MAX_NEW_KEPT,
      maxRecords: MAX_RECORDS,
      ...limits,
    };
    this.config = null;
    this.configChain = Promise.resolve();
    this.data = emptyData();
    this.dataUnreadable = false;
    // The sheets kept from the copy of the language of the configuration, and
    // the selection of the last 7 days among them, newest first.
    this.records = [];
    this.recalls = [];
    this.lastSuccessAt = null; // wall time the copy was read, for the texts
    this.lastSuccessMono = null; // the same on the monotonic clock (null: unknown)
    this.lastAttemptMono = null;
    this.sourceStale = false;
    this.lastModifiedDay = null;
    this.truncated = false;
    this.error = null; // { kind, status } of the last failed check
    this.pauseUntilMono = null;
    this.failures = 0;
    this.nextAtMono = null;
    this.cycleTimer = null;
    this.statusKey = undefined;
    this.running = null;
    this.downloading = null;
    this.lastRefreshMono = -Infinity;
    this.refreshTimer = null;
    this.signature = null;
    this.stopped = false;
    // Keys of the failures already logged, so a repeated one is not logged again.
    this.failing = new Set();
  }

  /** Log a failure once (warn or error), then at debug until `recovered(key)`. */
  failed(key, level, message, err) {
    const details = err ? [message, err] : [message];
    if (this.failing.has(key)) {
      logger.debug(...details);
      return;
    }
    this.failing.add(key);
    logger[level](...details);
  }

  /** One line when a failure logged by `failed(key)` is over. */
  recovered(key, message) {
    if (this.failing.delete(key)) {
      logger.info(message);
    }
  }

  intervalMs(config = this.config) {
    return config.refreshHours * this.timings.hourMs;
  }

  /** The age up to which a check is fresh: two intervals and an hour. */
  freshMs() {
    return 2 * this.intervalMs() + this.timings.hourMs;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.config = config;
    const { data, unreadable } = await this.store.load();
    this.dataUnreadable = unreadable;
    if (data?.version === 1) {
      this.data = { ...emptyData(), ...sanitize(data) };
    }
    // The copy kept under /data serves at once, as fresh as when it was read.
    this.adoptCopy();
    await this.publishDiscovered();
    this.warnAboutConfig();
    logger.info(`Started: the file of Health Canada is checked every ${config.refreshHours} h`);
    this.nextAtMono = this.monotonic() + this.restartDelay();
    await this.updateConnectionStatus();
    await this.publishStates();
    this.schedule();
  }

  /**
   * Take the copy of /data for the language of the configuration (swapping
   * the two copies if needed), with its freshness.
   */
  adoptCopy() {
    const language = this.config.language;
    const { data } = this;
    if (data.copy?.language !== language && data.otherCopy?.language === language) {
      const current = data.copy ? { ...data.copy, readAt: data.readAt } : null;
      data.copy = data.otherCopy;
      data.readAt = data.otherCopy.readAt ?? null;
      data.otherCopy = current;
    }
    const copy = data.copy?.language === language ? data.copy : null;
    this.records = copy?.records ?? [];
    this.lastSuccessAt = copy && Number.isFinite(data.readAt) ? data.readAt : null;
    this.lastSuccessMono = null;
    this.sourceStale = copy?.stale === true;
    this.lastModifiedDay = copy?.lastModifiedDay ?? null;
    if (this.lastSuccessAt !== null) {
      const age = this.now() - this.lastSuccessAt;
      // A time of /data in the future is not trusted.
      if (age >= 0) {
        this.lastSuccessMono = this.monotonic() - age;
      }
    }
    this.reselect();
  }

  /** Time to wait after a restart: the rest of the interval, or of a pause. */
  restartDelay() {
    const now = this.now();
    const interval = this.intervalMs();
    const { attemptAt, nextAt, pauseUntil } = this.data;
    let wait = 0;
    // A date of /data in the future is not trusted.
    if (Number.isFinite(attemptAt) && attemptAt <= now) {
      wait =
        Number.isFinite(nextAt) && nextAt >= attemptAt ? nextAt - now : attemptAt + interval - now;
    }
    if (
      Number.isFinite(pauseUntil) &&
      pauseUntil > now &&
      pauseUntil - now <= this.timings.maxPauseMs
    ) {
      wait = Math.max(wait, pauseUntil - now);
      this.pauseUntilMono = this.monotonic() + (pauseUntil - now);
    }
    return Math.min(Math.max(0, wait), Math.max(interval, this.timings.maxPauseMs));
  }

  /** Reconnection: Gladys may have restarted, publish everything again. */
  async resync(config) {
    await this.reconfigure(config, { quiet: true });
    await this.publishDiscovered();
    this.statusKey = undefined;
    await this.updateConnectionStatus();
    this.gladys.forgetPublishedStates?.();
    await this.publishStates();
    this.requestRefresh();
  }

  /** Configurations are applied one by one, in the order they came: the last wins. */
  reconfigure(config, options) {
    const run = this.configChain.then(() => this.applyConfig(config, options));
    this.configChain = run.catch(() => {});
    return run;
  }

  /** `config` null: the configuration in force is kept (a reconnection after a newer save). */
  async applyConfig(newConfig, { quiet = false } = {}) {
    const config = newConfig ?? this.config;
    const previous = this.config;
    this.config = config;
    if (!quiet) {
      logger.info('Configuration saved');
      this.warnAboutConfig();
    }
    const mono = this.monotonic();
    let moved = false;
    if (config.language !== previous?.language) {
      this.adoptCopy();
      // The other file: checked at once (a 304 if its copy is kept), unless a
      // file was read less than 5 minutes ago, and never during a pause.
      const earliest =
        this.lastAttemptMono === null ? mono : this.lastAttemptMono + this.timings.languageChangeMs;
      this.nextAtMono = Math.max(earliest, this.pauseUntilMono ?? mono);
      moved = true;
      await this.publishDiscovered();
    } else if (config.refreshHours !== previous?.refreshHours && this.failures === 0) {
      const base = this.lastAttemptMono ?? mono;
      this.nextAtMono = Math.max(base + this.intervalMs(config), this.pauseUntilMono ?? 0);
      moved = true;
    }
    if (this.config !== config) {
      // A newer configuration is already applied (never the case in the
      // chain, kept as a guard).
      return;
    }
    if (moved) {
      // Kept under /data: a restart follows the new time.
      this.data.nextAt = this.now() + Math.max(0, this.nextAtMono - this.monotonic());
      await this.save();
    }
    this.reselect();
    this.schedule();
    if (!quiet) {
      await this.updateConnectionStatus();
      await this.publishStates();
      this.requestRefresh();
    }
  }

  async stop() {
    this.stopped = true;
    this.clearTimer('cycleTimer');
    this.clearTimer('refreshTimer');
    // A download in progress is given up at once (Docker kills after 10 s).
    this.downloading?.abort();
    await this.running?.catch(() => {});
    await this.store.flush();
  }

  clearTimer(name) {
    if (this[name] !== null && this.timers) {
      this.timers.clearTimeout(this[name]);
    }
    this[name] = null;
  }

  schedule() {
    if (!this.timers || this.stopped || this.nextAtMono === null) {
      return;
    }
    this.clearTimer('cycleTimer');
    if (this.running) {
      // Scheduled again when the running check ends.
      return;
    }
    const wait = Math.max(0, this.nextAtMono - this.monotonic());
    this.cycleTimer = this.timers.setTimeout(() => {
      this.cycleTimer = null;
      this.runCycle();
    }, wait);
    this.cycleTimer?.unref?.();
  }

  warnAboutConfig() {
    if (this.config.categories.length === 0) {
      logger.warn('No category selected: nothing is followed');
    }
  }

  async publishDiscovered() {
    await this.gladys.publishDiscoveredDevices([buildDevice(this.gladys, this.config.language)]);
  }

  isCreated() {
    const id = deviceIds(this.gladys).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === id);
  }

  // --- Selection ---------------------------------------------------------------

  /** Not archived, in the followed categories, naming a followed word if any. */
  selected(recall) {
    const { categories, keywords } = this.config;
    if (recall.archived || !categories.includes(recall.category)) {
      return false;
    }
    if (keywords.length === 0) {
      return true;
    }
    const words = ` ${fold(`${recall.title} ${recall.product} ${recall.subcategory}`)} `;
    return keywords.some((keyword) => words.includes(` ${keyword} `));
  }

  /** The selection of the last 7 days, from the sheets kept. */
  reselect() {
    const from = dayBefore(localDay(this.now()), WEEK_DAYS - 1);
    this.recalls = this.records
      .filter(
        (recall) => recall.updated !== null && recall.updated >= from && this.selected(recall),
      )
      .sort(newestFirst);
  }

  // --- Checks ------------------------------------------------------------------

  runCycle() {
    if (this.running || this.stopped) {
      return this.running;
    }
    this.running = this.cycle()
      .catch((err) => this.failed('cycle', 'error', 'Check failed', err))
      .finally(() => {
        this.running = null;
        this.downloading = null;
        this.schedule();
      });
    return this.running;
  }

  async cycle() {
    const startMono = this.monotonic();
    const startWall = this.now();
    const language = this.config.language;
    const interval = this.intervalMs();
    this.lastAttemptMono = startMono;
    // The next check is armed before anything is awaited: a slow /data or a
    // failure never leaves the integration without one.
    this.nextAtMono = startMono + interval;
    this.data.attemptAt = startWall;
    this.data.nextAt = startWall + interval;
    await this.save();

    const copy = this.data.copy?.language === language ? this.data.copy : null;
    const known = Array.isArray(this.data.known) ? new Set(this.data.known) : null;
    const cutoff = dayBefore(localDay(startWall), KEEP_DAYS);
    const { maxKept, maxNewKept, maxRecords } = this.limits;
    let kept = 0;
    let keptNew = 0;
    let capped = false;
    const keep = (record) => {
      if (record.archived) {
        return false;
      }
      // A sheet never seen is kept apart: a bulk update of old sheets never
      // pushes a new recall out.
      if (known !== null && !known.has(record.nid)) {
        if (keptNew >= maxNewKept) {
          capped = true;
          return false;
        }
        keptNew += 1;
        return true;
      }
      if (record.updated === null || record.updated < cutoff) {
        return false;
      }
      if (kept >= maxKept) {
        capped = true;
        return false;
      }
      kept += 1;
      return true;
    };
    const controller = new AbortController();
    this.downloading = controller;
    let result;
    try {
      result = await download({
        fetch: this.fetch,
        language,
        baseUrl: this.baseUrl,
        etag: copy?.etag ?? null,
        lastModified: copy?.lastModified ?? null,
        sendEtag: copy?.imsOnly !== true,
        keep,
        maxRecords,
        timeouts: this.sourceTimeouts,
        signal: controller.signal,
      });
    } catch (err) {
      if (!this.stopped) {
        await this.onFailure(err, startMono, startWall);
      }
      return;
    } finally {
      this.downloading = null;
    }
    if (this.stopped || this.config.language !== language) {
      // Stopped, or the language changed meanwhile: the check of the new
      // language is already planned.
      return;
    }
    let imsOnly = false;
    if (result.modified && copy) {
      // The files are served through a CDN: an edge may still hold the copy of
      // the day before. An older file than the copy kept is not taken, and the
      // next checks send only the date, so such an edge answers 304.
      const fresh = httpDate(result.lastModified);
      const keptAt = httpDate(copy.lastModified);
      if (fresh !== null && keptAt !== null && fresh < keptAt) {
        logger.debug(
          `Older file served (${result.lastModified}): the copy of ${copy.lastModified} is kept`,
        );
        result = { modified: false, date: result.date, lastModified: copy.lastModified };
        imsOnly = true;
      }
    }
    if (!result.modified && !copy) {
      // A 304 for a copy this integration no longer has: read it in full next time.
      const err = new Error('304 without a copy');
      err.kind = 'noCopy';
      await this.onFailure(err, startMono, startWall);
      return;
    }
    this.failures = 0;
    this.error = null;
    this.pauseUntilMono = null;
    this.data.pauseUntil = null;
    this.recovered('source', 'The file of Health Canada can be read again');

    const lastModified = result.lastModified ?? copy?.lastModified ?? null;
    const sourceDate = result.date;
    const modifiedAt = httpDate(lastModified);
    // Compared to the Date header of the server, never to the local clock;
    // without both dates, the file is never said to be stale.
    this.sourceStale =
      sourceDate !== null && modifiedAt !== null && sourceDate - modifiedAt > STALE_MS;
    this.lastModifiedDay =
      modifiedAt === null ? null : new Date(modifiedAt).toISOString().slice(0, 10);

    let records;
    let knownNext;
    let pending;
    if (result.modified) {
      records = result.records;
      this.truncated = result.truncated || capped;
      if (result.skipped > 0) {
        logger.debug(`${result.skipped} sheet(s) too large, skipped`);
      }
      const all = new Set(result.nids);
      if (known === null) {
        logger.info(`First file read: ${all.size} sheets taken as known`);
        pending = [];
      } else {
        const previous = (this.data.pending ?? []).filter((nid) => all.has(nid));
        const fresh = records.filter((record) => !known.has(record.nid)).map((r) => r.nid);
        pending = [...new Set([...previous, ...fresh])];
      }
      // Every NID ever seen stays known (an older file served again never
      // makes a recall new twice), the oldest dropped beyond the bound.
      knownNext = new Set([...(known ?? []), ...all]);
      if (knownNext.size > MAX_KNOWN) {
        const sorted = [...knownNext].sort((a, b) => Number(a) - Number(b));
        knownNext = new Set(sorted.slice(sorted.length - MAX_KNOWN));
      }
      if (this.data.copy && this.data.copy.language !== language) {
        // The copy of the other language is kept: going back to it costs a 304.
        this.data.otherCopy = { ...this.data.copy, readAt: this.data.readAt };
      }
      this.data.copy = {
        language,
        etag: result.etag,
        lastModified: result.lastModified,
        imsOnly: false,
        records,
      };
    } else {
      records = copy.records;
      pending = this.data.pending ?? [];
      knownNext = known ?? new Set();
      this.data.copy.imsOnly = imsOnly || copy.imsOnly === true;
    }
    this.data.copy.stale = this.sourceStale;
    this.data.copy.lastModifiedDay = this.lastModifiedDay;
    this.records = records;
    this.reselect();
    logger.debug(
      `Check: ${result.modified ? `${records.length} recent sheet(s) kept` : 'file unchanged (304)'}, ${this.recalls.length} in the selection over 7 days`,
    );

    const left = await this.fireNew(pending, records, startWall);
    // A pending NID is never known: it stays pending until sent.
    for (const nid of left) {
      knownNext.delete(nid);
    }
    if (!result.modified) {
      for (const nid of pending) {
        if (!left.includes(nid)) {
          knownNext.add(nid);
        }
      }
    }
    this.data.known = [...knownNext];
    this.data.pending = left;
    this.lastSuccessAt = startWall;
    this.lastSuccessMono = startMono;
    this.data.readAt = startWall;
    this.recovered('cycle', 'Checks work again');
    await this.save();
    await this.publishStates();
    await this.updateConnectionStatus();
    const signature = this.recalls.map((recall) => `${recall.nid}:${recall.updated}`).join(',');
    if (signature !== this.signature) {
      this.signature = signature;
      this.requestRefresh();
    }
  }

  async onFailure(err, startMono, startWall) {
    this.failures += 1;
    this.error = { kind: err.kind ?? 'network', status: err.status ?? null };
    const interval = this.intervalMs();
    const { retryMs, minPauseMs, maxPauseMs } = this.timings;
    let wait = Math.min(interval, retryMs * 2 ** Math.min(this.failures - 1, 10));
    const status = err.status ?? null;
    if (status === 429 || (status !== null && status >= 500)) {
      // A pause, kept under /data so a restart honours it: Retry-After when
      // given, else the backoff, between 1 minute and 6 hours.
      wait = Math.min(maxPauseMs, Math.max(minPauseMs, err.retryAfterMs ?? wait));
      this.pauseUntilMono = startMono + wait;
      this.data.pauseUntil = startWall + wait;
    }
    this.nextAtMono = startMono + wait;
    this.data.nextAt = startWall + wait;
    this.failed('source', 'warn', `The file of Health Canada cannot be read: ${err.message}`);
    await this.save();
    await this.updateConnectionStatus();
  }

  /**
   * Fire the scene trigger for the pending NIDs still worth it; returns the
   * NIDs left pending (refused by Gladys, or beyond the cap of the check).
   */
  async fireNew(pending, records, wall) {
    if (pending.length === 0) {
      return [];
    }
    const byNid = new Map(records.map((record) => [record.nid, record]));
    const from = dayBefore(localDay(wall), FIRE_DAYS - 1);
    const toFire = pending
      .map((nid) => byNid.get(nid))
      .filter(
        (record) =>
          record !== undefined &&
          this.selected(record) &&
          (record.updated === null || record.updated >= from),
      )
      // Oldest first, so the scenes hear them in the order of publication.
      .sort(newestFirst)
      .reverse();
    const left = [];
    for (const [index, record] of toFire.entries()) {
      if (index >= MAX_EVENTS_PER_CYCLE || this.stopped) {
        left.push(record.nid);
        continue;
      }
      if (!(await this.fire(record))) {
        left.push(record.nid);
      }
    }
    if (left.length > 0) {
      logger.debug(`${left.length} new recall(s) left for the next check`);
    }
    // Pending NIDs stay unknown, so they count in the 500 sheets never seen
    // kept from a file: beyond, `truncated` is said in the status.
    return left.slice(-MAX_PENDING);
  }

  /** Fire one scene event; true once Gladys accepted it. */
  async fire(recall) {
    logger.debug(`New recall: sheet ${recall.nid}`);
    try {
      await this.gladys.publishSceneEvent(TRIGGERS.NEW, this.eventData(recall));
      this.recovered('scene', 'Scene triggers work again');
      return true;
    } catch (err) {
      this.failed('scene', 'warn', `Firing the scene trigger failed: ${err.message}`);
      return false;
    }
  }

  /** The flat data of a scene event (fields, then variables of the manifest). */
  eventData(recall) {
    const language = this.config.language;
    return {
      category: recall.category,
      category_name: CATEGORY_NAMES[language][recall.category],
      title: clip(recall.title, MAX_VARIABLE),
      product: clip(recall.product, MAX_VARIABLE),
      issue: clip(recall.issue, MAX_VARIABLE),
      recall_class: recall.recallClass,
      url: recall.url,
      summary: clip(
        PHRASES[language].summary({ title: clip(recall.title, 300), issue: recall.issue }),
        MAX_VARIABLE * 2,
      ),
    };
  }

  save() {
    return this.store.save(this.data);
  }

  // --- States ------------------------------------------------------------------

  /**
   * 'none' (never read in this language), 'old' (last check too old, or of an
   * unknown age), 'stale' (the file did not change for 3 days) or 'fresh'.
   */
  freshness() {
    if (this.lastSuccessAt === null) {
      return 'none';
    }
    if (this.lastSuccessMono === null || this.monotonic() - this.lastSuccessMono > this.freshMs()) {
      return 'old';
    }
    return this.sourceStale ? 'stale' : 'fresh';
  }

  /** States are published only from a recent check of a file that is not stale. */
  publishable() {
    return this.freshness() === 'fresh';
  }

  statesOf() {
    if (!this.publishable()) {
      return [];
    }
    const ids = deviceIds(this.gladys);
    const language = this.config.language;
    const [latest] = this.recalls;
    return [
      { device_feature_external_id: ids.week, state: Math.min(this.recalls.length, 10000) },
      {
        device_feature_external_id: ids.latest,
        text: latest ? describe(latest, language) : PHRASES[language].none,
      },
    ];
  }

  async publishStates() {
    if (!this.isCreated()) {
      return;
    }
    this.reselect();
    const states = this.statesOf();
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.recovered('publish', 'Publishing the states works again');
    } catch (err) {
      // Sent again at the next check (the SDK forgets what Gladys refused).
      this.failed('publish', 'warn', `Publishing the states failed: ${err.message}`);
    }
  }

  async updateConnectionStatus() {
    const parts = [];
    const language = this.config.language;
    if (this.error !== null) {
      parts.push(
        renderEach(STATUS, 'sourceDown', (l) => ({ error: describeError(this.error, l) })),
      );
      if (this.pauseUntilMono !== null && this.pauseUntilMono > this.monotonic()) {
        const at = this.now() + (this.pauseUntilMono - this.monotonic());
        parts.push(renderEach(STATUS, 'paused', (l) => ({ time: formatTime(at, l) })));
      }
    } else if (this.lastSuccessMono === null) {
      parts.push(render(STATUS, 'waiting'));
    }
    if (this.sourceStale && this.error === null && this.lastSuccessAt !== null) {
      parts.push(
        renderEach(STATUS, 'stale', (l) => ({ day: formatSourceDay(this.lastModifiedDay, l) })),
      );
    }
    if (this.config.categories.length === 0) {
      parts.push(render(STATUS, 'noCategory'));
    }
    if (this.dataUnreadable) {
      parts.push(render(STATUS, 'dataUnreadable'));
    } else if (!this.store.writable || this.store.writeFailed) {
      parts.push(render(STATUS, 'dataUnwritable'));
    }
    if (this.truncated) {
      parts.push(render(STATUS, 'truncated'));
    }
    const message = parts.length > 0 ? join(...parts) : undefined;
    const connected = this.error === null && this.lastSuccessMono !== null;
    const key = JSON.stringify([connected, message, language]);
    if (key === this.statusKey) {
      return;
    }
    this.statusKey = key;
    await this.gladys.setConnectionStatus(connected, message).catch(() => {});
  }

  // --- Gladys events -----------------------------------------------------------

  async onDeviceCreated(device) {
    if (device?.external_id !== deviceIds(this.gladys).device) {
      return;
    }
    // The SDK forgot the states of the device: published again, if fresh.
    await this.publishStates();
    this.requestRefresh();
  }

  /** onPoll fallback: should_poll is false; a Gladys polling anyway gets the fresh states. */
  async poll(device) {
    if (device?.external_id !== deviceIds(this.gladys).device) {
      return;
    }
    await this.publishStates();
  }

  /**
   * What the actions and the widget show: never a new download. `freshness`
   * says whether the recalls can be given as current; `warning` (multi-
   * language) says why not.
   */
  snapshot() {
    this.reselect();
    const freshness = this.freshness();
    let warning = null;
    if (freshness === 'none') {
      warning = render(STATUS, 'notYet');
    } else if (freshness === 'old') {
      warning = renderEach(STATUS, 'old', (l) => ({ time: formatDate(this.lastSuccessAt, l) }));
    } else if (freshness === 'stale') {
      warning = renderEach(STATUS, 'staleShort', (l) => ({
        day: formatSourceDay(this.lastModifiedDay, l),
      }));
    } else if (this.error !== null) {
      // Still fresh, but the last check failed: said along with the recalls.
      warning = renderEach(STATUS, 'lastFailed', (l) => ({
        error: describeError(this.error, l),
        time: formatDate(this.lastSuccessAt, l),
      }));
    }
    return {
      recalls: this.recalls,
      freshness,
      warning,
      readAt: this.lastSuccessAt,
    };
  }

  // --- Widget -------------------------------------------------------------------

  requestRefresh() {
    if (this.stopped) {
      return;
    }
    const mono = this.monotonic();
    const wait = this.lastRefreshMono + this.timings.widgetRefreshMs - mono;
    if (wait <= 0) {
      this.lastRefreshMono = mono;
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    } else if (this.timers && this.refreshTimer === null) {
      this.refreshTimer = this.timers.setTimeout(() => {
        this.refreshTimer = null;
        this.requestRefresh();
      }, wait);
      this.refreshTimer?.unref?.();
    }
  }
}

function emptyData() {
  return {
    version: 1,
    attemptAt: null,
    nextAt: null,
    readAt: null,
    pauseUntil: null,
    known: null,
    pending: [],
    copy: null,
    otherCopy: null,
  };
}

const isNid = (value) => typeof value === 'string' && /^\d{1,10}$/.test(value);
const isText = (value) => typeof value === 'string';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_FIELDS = [
  'title',
  'product',
  'category',
  'subcategory',
  'issue',
  'todo',
  'recallClass',
  'url',
];

/** A copy of /data with the expected shape, or null. */
function sanitizeCopy(copy) {
  if (
    !copy ||
    typeof copy !== 'object' ||
    !['en', 'fr'].includes(copy.language) ||
    !Array.isArray(copy.records)
  ) {
    return null;
  }
  const records = copy.records.filter(
    (r) =>
      r &&
      isNid(r.nid) &&
      TEXT_FIELDS.every((key) => isText(r[key])) &&
      (r.updated === null || DAY_RE.test(r.updated)),
  );
  return {
    language: copy.language,
    etag: isText(copy.etag) ? copy.etag : null,
    lastModified: isText(copy.lastModified) ? copy.lastModified : null,
    imsOnly: copy.imsOnly === true,
    stale: copy.stale === true,
    lastModifiedDay:
      isText(copy.lastModifiedDay) && DAY_RE.test(copy.lastModifiedDay)
        ? copy.lastModifiedDay
        : null,
    readAt: Number.isFinite(copy.readAt) ? copy.readAt : null,
    records: records
      .slice(0, MAX_KEPT + MAX_NEW_KEPT)
      .map((r) => ({ ...r, archived: r.archived === true })),
  };
}

/** Only what has the expected shape is taken from /data. */
export function sanitize(data) {
  const out = {};
  out.attemptAt = Number.isFinite(data.attemptAt) ? data.attemptAt : null;
  out.pauseUntil = Number.isFinite(data.pauseUntil) ? data.pauseUntil : null;
  out.readAt = Number.isFinite(data.readAt) ? data.readAt : null;
  out.nextAt = Number.isFinite(data.nextAt) ? data.nextAt : null;
  out.known = Array.isArray(data.known) ? data.known.filter(isNid) : null;
  out.pending = Array.isArray(data.pending) ? data.pending.filter(isNid).slice(-MAX_PENDING) : [];
  out.copy = sanitizeCopy(data.copy);
  out.otherCopy = sanitizeCopy(data.otherCopy);
  if (out.otherCopy?.language === out.copy?.language) {
    out.otherCopy = null;
  }
  return out;
}
