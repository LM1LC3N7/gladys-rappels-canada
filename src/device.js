// -----------------------------------------------------------------------------
// The one Gladys device of the integration: the recalls and safety alerts of
// the followed selection (categories, and brands or words if any).
//
// Features (couples checked against the Gladys front, see
// test/gladys-rules.test.js):
//   - recalls_week   counter-sensor/integer: sheets of the selection, not
//                    archived, whose "last updated" day is one of the last 7
//                    days (today included, time zone of Gladys);
//   - latest_recall  text/text: the newest one, with its day.
//
// Published with should_poll: false: the refresh runs in the container
// (src/monitor.js). The platform id is fixed: there is one selection per Gladys.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'recalls';
export const PLATFORM_ID = 'selection';
export const FEATURE_KEYS = { WEEK: 'recalls_week', LATEST: 'latest_recall' };

export const MAX_COUNT = 10000;

// Feature names, frozen at creation in Gladys (language of the configuration).
export const NAMES = {
  en: {
    device: 'Recalls in Canada',
    recalls_week: 'Recalls in 7 days',
    latest_recall: 'Latest recall',
  },
  fr: {
    device: 'Rappels au Canada',
    recalls_week: 'Rappels sur 7 jours',
    latest_recall: 'Dernier rappel',
  },
};

/** External ids of the device and of its features. */
export function deviceIds(gladys) {
  const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
  return {
    device: ids.device,
    week: ids.feature(FEATURE_KEYS.WEEK),
    latest: ids.feature(FEATURE_KEYS.LATEST),
  };
}

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

/** The discovery payload of the device. */
export function buildDevice(gladys, language = 'fr') {
  const ids = deviceIds(gladys);
  const names = NAMES[language] ?? NAMES.fr;
  return {
    name: names.device,
    external_id: ids.device,
    model: 'Health Canada open data',
    should_poll: false,
    params: [],
    features: [
      sensor(
        names.recalls_week,
        ids.week,
        DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        TYPES.SENSOR.INTEGER,
        { keep_history: true, min: 0, max: MAX_COUNT },
      ),
      sensor(names.latest_recall, ids.latest, DEVICE_FEATURE_CATEGORIES.TEXT, TYPES.TEXT.TEXT, {
        keep_history: false,
        min: 0,
        max: 0,
      }),
    ],
  };
}
