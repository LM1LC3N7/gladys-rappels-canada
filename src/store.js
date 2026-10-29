// -----------------------------------------------------------------------------
// Persistence under /data (the only writable path of the container): the
// validators of the copy read (ETag, Last-Modified) with the recent sheets
// kept from it, so a restart answered by a 304 still has its recalls; the
// NIDs of the last file, so a restart fires nothing that is not news; the
// time of the last attempt and of a pause, so a restart never reads faster
// than the interval.
//
// A missing file is a first start. A file that cannot be read is not taken as
// empty: `load()` says so (`unreadable`), and the monitor then keeps its state
// in memory and writes nothing over it, except a file that is not JSON at all,
// moved aside to `<name>.bad` once, then started afresh.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'rappels-canada-store' });
export const FILE_NAME = 'rappels-canada.json';
// Above a full state (250,000 NIDs, two copies of 2,000 sheets): never
// written larger (save() drops the copies first, never the NIDs seen).
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class Store {
  constructor(
    directory = process.env.RAPPELS_CANADA_DATA_DIR || '/data',
    { maxFileBytes = MAX_FILE_BYTES } = {},
  ) {
    this.maxFileBytes = maxFileBytes;
    this.directory = directory;
    this.path = join(directory, FILE_NAME);
    this.pending = null;
    this.writing = null;
    this.latest = null;
    // A failing disk would fail every save: logged once, then at debug.
    this.writeFailed = false;
    // false while /data holds a file that could not be read.
    this.writable = true;
  }

  /** `{ data, unreadable }`: data is null for a first start or an unreadable file. */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { data: null, unreadable: false };
      }
      logger.warn(`Cannot read ${this.path}: ${err.message}`);
      this.writable = false;
      return { data: null, unreadable: true };
    }
    if (text.length > this.maxFileBytes) {
      logger.warn(`${this.path} is too large (${text.length} bytes): ignored`);
      return this.setAside();
    }
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return { data, unreadable: false };
      }
    } catch {
      // handled below
    }
    logger.warn(`${this.path} is not valid JSON`);
    return this.setAside();
  }

  async setAside() {
    try {
      await rename(this.path, `${this.path}.bad`);
      logger.warn(`${this.path} moved to ${FILE_NAME}.bad`);
    } catch (err) {
      logger.warn(`Cannot move ${this.path} aside: ${err.message}`);
      this.writable = false;
    }
    return { data: null, unreadable: true };
  }

  /**
   * /data is created by the image (Dockerfile): it is never created here, so
   * nothing is written anywhere else. Writes are coalesced and atomic (temporary file + rename): a crash never
   * leaves half a JSON file behind. Resolves to true once this state (or a
   * later one) is on disk, false if the write failed or is not allowed.
   */
  save(data) {
    this.latest = data;
    if (!this.writable) {
      return Promise.resolve(false);
    }
    if (!this.pending) {
      // Chained after the write in progress, if any: one writer at a time.
      this.pending = (this.writing ?? Promise.resolve()).then(async () => {
        const snapshot = this.serialize(this.latest);
        this.pending = null;
        try {
          const temporary = `${this.path}.tmp`;
          await writeFile(temporary, snapshot);
          await rename(temporary, this.path);
          if (this.writeFailed) {
            this.writeFailed = false;
            logger.info(`${this.path} written again`);
          }
          return true;
        } catch (err) {
          if (this.writeFailed) {
            logger.debug(`Cannot write ${this.path}: ${err.message}`);
          } else {
            this.writeFailed = true;
            logger.warn(`Cannot write ${this.path}: ${err.message}`);
          }
          return false;
        }
      });
      this.writing = this.pending;
    }
    return this.pending;
  }

  /**
   * The JSON of the state, within MAX_FILE_BYTES: the copy of the other
   * language goes first, then the sheets of the current copy (read again in
   * full at the next check); the NIDs seen and the pending events stay.
   */
  serialize(data) {
    let text = JSON.stringify(data);
    if (text.length <= this.maxFileBytes) {
      return text;
    }
    logger.warn(`State of ${text.length} bytes: the copies of the file are not kept`);
    text = JSON.stringify({ ...data, otherCopy: null });
    if (text.length <= this.maxFileBytes) {
      return text;
    }
    return JSON.stringify({ ...data, otherCopy: null, copy: null });
  }

  /** Resolves once every write requested so far is on disk (or failed). */
  async flush() {
    await this.writing;
  }
}
