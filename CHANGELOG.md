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
- Status of the source: unreachable (with retries and pauses kept across
  restarts), stale file, `/data` unreadable or unwritable.
