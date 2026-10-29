// -----------------------------------------------------------------------------
// The open data "Recalls and safety alerts" of the Government of Canada
// (Health Canada, Open Government Licence – Canada): one JSON file per
// language, every recall and alert since 1991 (CFIA food recalls, consumer
// products, Transport Canada vehicles, drugs and health products, medical
// devices). Public and keyless: no header carries a secret.
//
// Facts measured on 29/10/2026:
//   - HCRSAMOpenData.json (English, 16 MB) and SCRSAMDonneesOuvertes.json
//     (French, 21 MB), 34,309 sheets each, the same NIDs in both; regenerated
//     once a day around 02:15 UTC; served with ETag and Last-Modified, and a
//     conditional GET answers 304 without a body; no gzip;
//   - a sheet: NID (digits), title, URL, organization, product, issue, what to
//     do, category, recall class, "last updated" (YYYY-MM-DD, null for 8 %),
//     archived ("0" or "1"); the publication date is not in the file;
//   - texts hold zero-width spaces and \uXXXX escapes, no HTML.
//
// The body is read as a stream (src/jsonArray.js): only the NIDs and the
// sheets worth keeping stay in memory, never the file.
// -----------------------------------------------------------------------------

import { categoryKey } from './config.js';
import { JsonArrayReader } from './jsonArray.js';

export const BASE_URL =
  'https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/';
export const FILES = { en: 'HCRSAMOpenData.json', fr: 'SCRSAMDonneesOuvertes.json' };
export const SITE_URL = {
  en: 'https://recalls-rappels.canada.ca/en',
  fr: 'https://recalls-rappels.canada.ca/fr',
};
export const USER_AGENT =
  'gladys-rappels-canada/0.1.0 (Gladys Assistant integration; +https://github.com/LM1LC3N7/gladys-rappels-canada)';

// Bounds: three times the French file, and five times its count of sheets.
export const MAX_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDS = 200000;
// The longest sheet of 29/10/2026 is 12 KB (its "what to do" text).
export const MAX_OBJECT_BYTES = 64 * 1024;
// No answer (headers) in 30 s, no byte for 60 s, or the whole file in more
// than 10 minutes: the download is given up.
export const HEADERS_TIMEOUT_MS = 30000;
export const STALL_TIMEOUT_MS = 60000;
export const TOTAL_TIMEOUT_MS = 10 * 60000;

// Column names of each file.
const COLUMNS = {
  en: {
    title: 'Title',
    product: 'Product',
    issue: 'Issue',
    todo: 'What you should do',
    category: 'Category',
    recallClass: 'Recall class',
    updated: 'Last updated',
    archived: 'Archived',
  },
  fr: {
    title: 'Titre',
    product: 'Produit',
    issue: 'Problème',
    todo: 'Ce que vous devriez faire',
    category: 'Catégorie',
    recallClass: 'Classe de rappel',
    updated: 'Dernière mise à jour',
    archived: 'Archivé',
  },
};

export class SourceError extends Error {
  /**
   * @param {string} message
   * @param {object} [details] status (HTTP), retryAfterMs
   */
  constructor(message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Text of a cell: no zero-width or control characters, single spaces, clipped. */
// The HTML entities found in the files (29/10/2026): &nbsp; and &amp; by the
// thousands, a few &rsquo;, &lt; and &gt;. Numeric ones are decoded too.
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  rsquo: '’',
  lsquo: '‘',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
};
const entity = (match, name) => {
  if (name[0] === '#') {
    const code =
      name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    const valid =
      Number.isInteger(code) &&
      code >= 0x20 &&
      code <= 0x10ffff &&
      (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : ' ';
  }
  return ENTITIES[name] ?? match;
};

export function clean(value, max = 500) {
  const text = String(value ?? '')
    .replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, entity)
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    // Control characters (C0, DEL, C1) become spaces.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One sheet as a plain object; null when it cannot be used. */
export function normalizeRecord(raw, language) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const nid = typeof raw.NID === 'string' || typeof raw.NID === 'number' ? String(raw.NID) : '';
  if (!/^\d{1,10}$/.test(nid)) {
    return null;
  }
  const columns = COLUMNS[language];
  const url = clean(raw.URL, 300);
  const updated = clean(raw[columns.updated], 10);
  const title = clean(raw[columns.title], 300);
  const product = clean(raw[columns.product], 300);
  return {
    nid,
    title: title || product || nid,
    product,
    category: categoryKey(raw.Organization),
    organization: clean(raw.Organization, 100),
    subcategory: clean(raw[columns.category], 100),
    issue: clean(raw[columns.issue], 200),
    todo: clean(raw[columns.todo], 1000),
    recallClass: clean(raw[columns.recallClass], 40),
    updated: DAY_RE.test(updated) ? updated : null,
    archived: String(raw[columns.archived] ?? '').trim() === '1',
    url: /^https:\/\/recalls-rappels\.canada\.ca\/\S+$/.test(url) ? url : SITE_URL[language],
  };
}

/** An HTTP date in ms, or null. */
export function httpDate(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Retry-After in ms (seconds or an HTTP date, against the Date header), or null. */
export function retryAfterMs(headers) {
  const value = headers.get('retry-after');
  if (value === null) {
    return null;
  }
  if (/^\d{1,9}$/.test(value.trim())) {
    return Number(value.trim()) * 1000;
  }
  const at = httpDate(value);
  const date = httpDate(headers.get('date'));
  return at !== null && date !== null ? Math.max(0, at - date) : null;
}

/**
 * Download the file of `language`, conditionally.
 *
 * @param {object} options
 * @param {Function} options.fetch
 * @param {string} options.language 'en' or 'fr'
 * @param {string} [options.baseUrl] test seam
 * @param {string|null} [options.etag] of the copy already read
 * @param {string|null} [options.lastModified] of the copy already read
 * @param {(record: object) => boolean} options.keep the sheets kept in memory
 * @returns {Promise<object>} `{ modified: false, date, lastModified }` or
 *   `{ modified: true, etag, lastModified, date, nids, records, skipped, truncated }`
 */
export async function download({
  fetch: fetchImpl,
  language,
  baseUrl = BASE_URL,
  etag = null,
  lastModified = null,
  keep,
  maxBytes = MAX_BYTES,
  timeouts = {},
}) {
  const url = `${baseUrl}${FILES[language]}`;
  const host = new URL(url).host;
  const limits = {
    headers: HEADERS_TIMEOUT_MS,
    stall: STALL_TIMEOUT_MS,
    total: TOTAL_TIMEOUT_MS,
    ...timeouts,
  };
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  // The validators come from the server: kept only when they are plain text.
  if (etag && /^[\x20-\x7e]{1,200}$/.test(etag)) {
    headers['If-None-Match'] = etag;
  }
  if (lastModified && /^[\x20-\x7e]{1,100}$/.test(lastModified)) {
    headers['If-Modified-Since'] = lastModified;
  }
  const controller = new AbortController();
  let reason = null;
  const abort = (why) => {
    reason ??= why;
    controller.abort();
  };
  const total = setTimeout(() => abort(`not read in ${limits.total / 1000} s`), limits.total);
  let stall = setTimeout(() => abort(`no answer in ${limits.headers / 1000} s`), limits.headers);
  const rearm = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort(`no data for ${limits.stall / 1000} s`), limits.stall);
  };
  try {
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
    } catch (err) {
      throw new SourceError(`${host}: ${reason ?? err?.cause?.code ?? err.message}`);
    }
    const date = httpDate(response.headers.get('date'));
    const modifiedAt = response.headers.get('last-modified');
    if (response.status === 304) {
      await response.body?.cancel().catch(() => {});
      return { modified: false, date, lastModified: modifiedAt };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError(`${host}: HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers),
      });
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new SourceError(`${host}: file of ${length} bytes, more than ${maxBytes}`);
    }
    const nids = [];
    const records = [];
    let truncated = false;
    const reader = new JsonArrayReader({
      maxObjectBytes: MAX_OBJECT_BYTES,
      onObject: (raw) => {
        if (nids.length >= MAX_RECORDS) {
          truncated = true;
          return;
        }
        const record = normalizeRecord(raw, language);
        if (record === null) {
          return;
        }
        nids.push(record.nid);
        if (keep(record)) {
          records.push(record);
        }
      },
    });
    const decoder = new TextDecoder('utf-8');
    let bytes = 0;
    rearm();
    try {
      for await (const chunk of response.body) {
        rearm();
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          abort(`more than ${maxBytes} bytes`);
          break;
        }
        reader.write(decoder.decode(chunk, { stream: true }));
      }
      if (reason) {
        throw new SourceError(`${host}: ${reason}`);
      }
      reader.write(decoder.decode());
      reader.end();
    } catch (err) {
      if (err instanceof SourceError) {
        throw err;
      }
      throw new SourceError(`${host}: ${reason ?? `unexpected file (${err.message})`}`);
    }
    if (nids.length === 0) {
      throw new SourceError(`${host}: empty file`);
    }
    return {
      modified: true,
      etag: response.headers.get('etag'),
      lastModified: modifiedAt,
      date,
      nids,
      records,
      skipped: reader.skipped,
      truncated,
    };
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
  }
}
