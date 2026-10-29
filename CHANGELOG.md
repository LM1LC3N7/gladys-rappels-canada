# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Recalls and safety alerts of Canada from the open data of Health Canada
  (English or French file), checked every 3 to 24 hours with conditional
  requests and read as a stream (bounded memory).
- A device: recalls of the selection over 7 days, latest recall.
- Selection by category (food, consumer products, vehicles, health products,
  medical devices, other) and by brands or words.
- Scene trigger `new_recall` (a new sheet in the selection), scene action
  `read_recalls`, widget `recalls`, configuration action `check_now`.
- Status of the source in words: unreachable (with retries and pauses kept
  across restarts), stale file, file of another format, `/data` unreadable or
  unwritable.
- Recalls not up to date (last check too old, stale file) are never given as
  current: the scene action fails with the reason, the button and the widget
  say it.
- A copy per language, configurations applied in order, a restart publishing
  the fresh copy kept, a download given up at once on stop.
- A configuration saved during a reconnection is never overwritten by the
  configuration read for it; a failed check while the recalls are still up to
  date adds a warning to them.
