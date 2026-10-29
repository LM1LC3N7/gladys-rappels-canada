# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
reads public data and reuses the structure of the projects below, each
distributed under its own license.

## Recalls and Safety Alerts (Health Canada)

The data read at runtime, and the excerpts recorded in `test/fixtures`
(`HCRSAMOpenData-*.json`, `SCRSAMDonneesOuvertes-*.json`, captured on
29/10/2026: a subset of the sheets with their values unmodified, and the
first bytes of each file as served):
<https://open.canada.ca/data/en/dataset/d38de914-c94c-429b-8ab1-8776c31643e3>.

Contains information licensed under the Open Government Licence – Canada
(<https://open.canada.ca/en/open-government-licence-canada>). / Contient des
informations visées par la Licence du gouvernement ouvert – Canada.

This integration is not affiliated with, nor endorsed by, the Government of
Canada.

## gladys-rappelconso (guim31/gladys-rappelconso)

<https://github.com/guim31/gladys-rappelconso>, version 1.0.1, branch `main`
(cloned 29/10/2026). Apache License 2.0.

Its structure was reused and adapted: the wiring of the handlers
(`src/app.js`), the monitor that fires the scene events once and remembers
what was seen (`src/monitor.js`), the coalesced atomic writes under /data
(`src/store.js`), the device, the actions and the widget, the multi-language
messages, and the test of the Gladys rules with its table
`test/fixtures/gladys-feature-table.json`.

## gladys-testkit and gladys-span-panel

`test/kit/clock.mjs` (virtual and sped-up clocks) comes from gladys-testkit,
and `test/encoding.test.js` and `scripts/cover.mjs` (drawing helpers) from
gladys-span-panel: same author, Apache License 2.0.

## @gladysassistant/integration-sdk

The runtime dependency: <https://github.com/GladysAssistant/integration-sdk-js>,
Apache License 2.0.
