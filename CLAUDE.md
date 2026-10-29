# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the open data "Recalls and safety
alerts" of Health Canada (one JSON file per language, 16 to 21 MB, regenerated
once a day) and turns it into a device, a scene trigger, a scene action and a
widget.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/monitor.test.js          # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/cover.mjs cover.png          # regenerate the cover
```

On the maintainer's VM: `gi test`, `gi ci` (the whole GitHub CI locally).

## Architecture

```
index.js              SDK wiring only (registerHandlers, shutdown)
src/app.js            handlers; getConfig() retried without end in `connected`
src/monitor.js        schedule (monotonic clock), checks, selection, new recalls, states, status
src/source.js         conditional download, bounds (size, time), columns EN/FR, cleaning of the texts
src/jsonArray.js      streaming reader of the JSON array (one sheet in memory at a time)
src/store.js          /data: validators, recent sheets, NIDs seen, attempt and pause times
src/device.js         the one device (recalls_week, latest_recall)
src/actions.js        check_now, read_recalls (answer from memory, never download)
src/widgets.js        the `recalls` widget
src/messages.js       texts EN/FR, dates
src/config.js         DEFAULT_CONFIG (mirrors the manifest) + normalization, categories
test/helpers/         fake Health Canada server (real HTTP on 127.0.0.1), test world
test/kit/clock.mjs    virtual and sped-up clocks (from gladys-testkit)
```

## Rules

- **Cadence of the source**: one request at a time, conditional (ETag and
  Last-Modified), never faster than the interval (restart included: the
  attempt and the next time are in /data before the request leaves), honest
  User-Agent. The actions and the widget never download.
- **No invented value**: a source unreachable or stale is said in the status;
  nothing is published as 0 for it; states are published only after a recent
  check of a fresh file.
- **External ids are forever** (`gladys.externalIds('recalls', 'selection')`),
  as the manifest keys, feature keys, trigger and widget keys.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions**: 0.1.0 set by hand for the first release; then the Release
  workflow owns them. `test/manifest.test.js` checks they agree.
- **Changelog** under `## [Unreleased]`.
- **User-facing text** in English and French: manifest, messages, docs
  (`docs/en.md` / `docs/fr.md` kept in sync), checked by
  `test/encoding.test.js` (clean UTF-8, forbidden words).
- **Tests never touch the network** beyond 127.0.0.1. Temporary /data folders
  are removed after each test.
