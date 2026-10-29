// -----------------------------------------------------------------------------
// The scene action `read_recalls` and the configuration action `check_now`.
// Both answer from the last file read, without downloading it again (the file
// is checked on its own schedule, never faster), with the recalls of the last
// 7 days as one sentence: something a scene can send by message or read
// aloud, newest first. Recalls that are not up to date (last check too old,
// file of Health Canada stale) are never given as current: the scene action
// fails with the reason, the configuration action says it instead of a count.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { LANGUAGES } from './config.js';
import { STATUS, formatDate, sentence } from './messages.js';

const logger = createLogger({ name: 'rappels-canada-actions' });

export const SCENE_ACTION = 'read_recalls';
export const CONFIG_ACTION = 'check_now';

/** Scene action: outputs `text` and `count`; throws unless the recalls are up to date. */
export async function readRecalls(monitor) {
  const { recalls, freshness, warning } = monitor.snapshot();
  const language = monitor.config.language;
  if (freshness !== 'fresh') {
    throw new Error(warning[language]);
  }
  return {
    text: sentence(recalls, language),
    count: recalls.length,
  };
}

/** Configuration action: the recalls of the selection, in every language. */
export async function checkNow(monitor) {
  const { recalls, freshness, warning, readAt } = monitor.snapshot();
  logger.info(
    `Check requested: ${freshness === 'fresh' ? `${recalls.length} recall(s) in 7 days` : `recalls ${freshness}`}`,
  );
  if (freshness !== 'fresh') {
    return warning;
  }
  return Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      STATUS[language].summary({
        text: sentence(recalls, language),
        time: formatDate(readAt, language),
      }),
    ]),
  );
}
