# gladys-rappels-canada

Recalls and safety alerts in Canada for [Gladys Assistant](https://gladysassistant.com),
read from the open data of Health Canada (CFIA food recalls, consumer
products, Transport Canada vehicles, drugs and health products, medical
devices): a device (recalls in 7 days, latest recall), a scene trigger for
each new recall of your selection, a scene action and a dashboard widget.
English and French.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Tested against the real file of Health Canada and in a test Gladys on
  29/10/2026; not yet over weeks of real use.
- Requires Gladys 5.1.0 or later. No account, no key.

## Development

```bash
npm install
npm test               # node --test, against the SDK's fake Gladys and a fake Health Canada server
npm run lint
npm run format:check
node scripts/cover.mjs cover.png
```

See `CLAUDE.md` for the architecture and the rules.

## Licence

Apache License 2.0 (`LICENSE`); third-party notices in `THIRD_PARTY_NOTICES.md`.
Contains information licensed under the Open Government Licence – Canada.
Not affiliated with the Government of Canada.
