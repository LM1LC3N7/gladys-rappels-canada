# TODO

## Before announcing

- [x] Review r1 (2026-10-29): REFUSÉ, 3 important, 9 minor: fixed.
- [x] Review r2 (2026-10-29): REFUSÉ, 1 important, 3 minor: fixed.
- [ ] Review r3.
- [ ] Try on a real Gladys 5.1+: device creation, the widget, a scene on
      `new_recall` over a few days, the scene action.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store: `keywords` (recall, rappel, Canada, CFIA, ACIA, Health Canada,
      Santé Canada) and `countries` (CA) once the core accepts them.

## To watch on the real service

- [ ] Whether the file is regenerated every day, weekends included (the stale
      alarm is at 3 days).
- [ ] Whether the CDN serves an older copy after a newer one (seen once on
      29/10/2026: 179 recent sheets then 185; handled, an older
      Last-Modified is ignored).
- [ ] New values of `Organization` (filed under "other" until mapped).

## Decisions

- Version 0.1.0 set by hand in package.json, its lock, the manifest and the
  image tag (`ghcr.io/lm1lc3n7/gladys-rappels-canada:0.1.0`); SDK ^0.16.0, the
  latest published on 29/10/2026.
- Source: the open data file `HCRSAMOpenData.json` / `SCRSAMDonneesOuvertes.json`
  of recalls-rappels.canada.ca. The old API `healthycanadians.gc.ca/.../api/recent`
  still answers but stopped in 2021: not used. One file only, the one of the
  language chosen (never both).
- Cadence: a conditional GET (ETag and Last-Modified, both answered by the
  server with 304) every 3, 6 (default), 12 or 24 hours; the full download
  happens only when the file changed, about once a day. Honest User-Agent
  naming the integration and its repository.
- Memory: the file is read as a stream (src/jsonArray.js); only the NIDs and
  the sheets of the last 30 days are kept (1,500 at most, plus 500 sheets
  never seen; /data stays under 16 MB, the copies dropped first, never the
  NIDs), the body is capped
  at 64 MB, one sheet at 64 KB (skipped beyond), 200,000 sheets at most.
  Measured on the real file: about 50 MB of RSS more during a download.
- "New recall" = a NID never seen in a file before, in the selection, updated
  within 7 days or undated. Every NID seen stays known (250,000 at most), so
  a CDN serving an older file never makes a recall new twice. The first file
  fires nothing.
- The counter counts sheets by "last updated" (the file has no publication
  date): documented.
- Stale file: Last-Modified more than 3 days before the server's Date header
  (never compared to the local clock, never stale without both); then the
  states are not published, the status says it.
- Medical devices off by default (a quarter of the sheets, professional
  equipment).
- Texts: English and French only (the languages of the source); the manifest
  carries both.
- Catalog categories: `environment` (open-data daily-life feeds) and
  `notifications`.
- No `poll_frequency`: the integration runs its own schedule, like the
  neighbour gladys-rappelconso.
- Freshness (review r1): up to date = last success within two intervals and
  an hour, file not stale. Otherwise no state, the scene action fails with
  the reason, the button and the widget say it. A restart publishes the copy
  of /data while it is fresh.
- Scene events are at least once (sent before /data records them).
- A file with fewer than half of its sheets dated is refused (renamed column).
- After an older file from a CDN edge, only If-Modified-Since is sent until a
  newer file comes (the edge answers 304).
- User-Agent version read from package.json.
