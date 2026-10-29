// -----------------------------------------------------------------------------
// The scene action `read_recalls` and the configuration action `check_now`.
// Both answer from the last file read, without downloading it again (the file
// is checked on its own schedule, never faster), with the recalls of the last
// 7 days as one sentence: something a scene can send by message or read
// aloud, newest first.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { LANGUAGES } from './config.js';
import { STATUS, formatDate, render, sentence } from './messages.js';

const logger = createLogger({ name: 'rappels-canada-actions' });

export const SCENE_ACTION = 'read_recalls';
export const CONFIG_ACTION = 'check_now';

/** Scene action: outputs `text` and `count`; throws if the file was never read. */
export async function readRecalls(monitor) {
  const { recalls, ok } = monitor.snapshot();
  if (!ok) {
    throw new Error(render(STATUS, 'notYet')[monitor.config.language]);
  }
  return {
    text: sentence(recalls, monitor.config.language),
    count: recalls.length,
  };
}

/** Configuration action: the recalls of the selection, in every language. */
export async function checkNow(monitor) {
  const { recalls, ok, readAt } = monitor.snapshot();
  logger.info(
    `Check requested: ${ok ? `${recalls.length} recall(s) in 7 days` : 'file not read yet'}`,
  );
  if (!ok) {
    return render(STATUS, 'notYet');
  }
  return Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      STATUS[language].summary({
        text: sentence(recalls, language),
        time: readAt === null ? '?' : formatDate(readAt, language),
      }),
    ]),
  );
}
