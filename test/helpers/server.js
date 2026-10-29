// -----------------------------------------------------------------------------
// A fake recalls-rappels.canada.ca on 127.0.0.1: serves the two open data
// files (built from the real captures of test/fixtures) the way the real
// server does on 29/10/2026: ETag and Last-Modified, a 304 for a matching
// If-None-Match or If-Modified-Since, a Date header, no gzip. Faults on demand:
// a status (with Retry-After), a dropped connection, a body that stalls, a body
// larger than announced, no Date header.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

export const fixture = (name) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

export const FILE_EN = 'HCRSAMOpenData.json';
export const FILE_FR = 'SCRSAMDonneesOuvertes.json';
const PATH = '/sites/default/files/opendata-donneesouvertes/';

// French columns of an English record.
const FR_KEYS = {
  Title: 'Titre',
  Product: 'Produit',
  Issue: 'Problème',
  'What you should do': 'Ce que vous devriez faire',
  Category: 'Catégorie',
  'Recall class': 'Classe de rappel',
  'Last updated': 'Dernière mise à jour',
  Archived: 'Archivé',
};

export function toFrench(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      FR_KEYS[key] ?? key,
      key === 'URL' ? value.replace('/en/alert-recall/', '/fr/avis-rappel/') : value,
    ]),
  );
}

/**
 * @param {object} [options]
 * @param {string} [options.lastModified] HTTP date of the files
 * @param {() => string|null} [options.date] the Date header (null: none)
 */
export async function startServer({
  lastModified = 'Thu, 29 Oct 2026 02:14:39 GMT',
  date = () => 'Thu, 29 Oct 2026 16:00:00 GMT',
} = {}) {
  const records = {
    en: JSON.parse(fixture('HCRSAMOpenData-2026-10-29.json')),
    fr: JSON.parse(fixture('SCRSAMDonneesOuvertes-2026-10-29.json')),
  };
  let version = 1;
  const srv = {
    records,
    lastModified,
    date,
    // false, a status (503, 429, 404…), 'drop', 'stall', 'oversize', 'chunked-oversize'
    fault: false,
    slowMs: 150,
    retryAfter: null,
    requests: [],
    raw: null,
    etag: (language) => `"fake-${language}-${version}"`,
    body(language) {
      return srv.raw?.[language] ?? JSON.stringify(records[language]);
    },
    /** Publish a new sheet in both files (a new NID): the files change. */
    publish(record) {
      records.en.unshift(record);
      records.fr.unshift(toFrench(record));
      srv.touch();
    },
    /** The files are regenerated (new ETag and Last-Modified). */
    touch(at = 'Thu, 29 Oct 2026 03:00:00 GMT') {
      version += 1;
      srv.lastModified = at;
    },
    count: (file) => srv.requests.filter((r) => r.url.endsWith(file)).length,
  };
  const server = createServer((req, res) => {
    srv.requests.push({ url: req.url, headers: req.headers, method: req.method });
    const language =
      req.url === `${PATH}${FILE_EN}` ? 'en' : req.url === `${PATH}${FILE_FR}` ? 'fr' : null;
    const headers = {};
    const dateValue = srv.date();
    if (dateValue !== null) {
      headers.Date = dateValue;
    } else {
      res.sendDate = false;
    }
    if (srv.fault === 'drop') {
      req.socket.destroy();
      return;
    }
    if (typeof srv.fault === 'number') {
      if (srv.retryAfter !== null) {
        headers['Retry-After'] = String(srv.retryAfter);
      }
      res.writeHead(srv.fault, headers);
      res.end('error');
      return;
    }
    if (language === null) {
      res.writeHead(404, headers);
      res.end('not found');
      return;
    }
    headers.ETag = srv.etag(language);
    headers['Last-Modified'] = srv.lastModified;
    if (srv.fault === 'redirect') {
      res.writeHead(302, { ...headers, Location: `${srv.baseUrl}${FILE_EN}` });
      res.end();
      return;
    }
    if (srv.fault === 'force304') {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    // HTTP: If-None-Match decides when sent; else If-Modified-Since, a file
    // not modified after that date being a 304.
    const inm = req.headers['if-none-match'];
    const ims = Date.parse(req.headers['if-modified-since'] ?? '');
    if (
      inm === headers.ETag ||
      (inm === undefined && Number.isFinite(ims) && Date.parse(srv.lastModified) <= ims)
    ) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const body = Buffer.from(srv.body(language));
    if (srv.fault === 'unclosed') {
      // A clean end of stream, but the array is not closed.
      const text = body.toString();
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(text.slice(0, text.lastIndexOf('}') + 1));
      return;
    }
    if (srv.fault === 'slow') {
      // Alive but slow: a chunk every `slowMs`, longer in all than the stall limit.
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      const size = Math.ceil(body.length / 6);
      let at = 0;
      const next = () => {
        if (res.destroyed) return;
        res.write(body.subarray(at, at + size));
        at += size;
        if (at >= body.length) res.end();
        else setTimeout(next, srv.slowMs);
      };
      next();
      return;
    }
    if (srv.fault === 'stall') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.write(body.subarray(0, 1000));
      // Never ends: the client gives up.
      return;
    }
    if (srv.fault === 'oversize') {
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': String(100 * 1024 * 1024),
      });
      res.write(body.subarray(0, 1000));
      srv.oversizeSocket = req.socket;
      return;
    }
    if (srv.fault === 'chunked-oversize') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      res.write('[');
      let sent = 0;
      const push = () => {
        while (sent < 200 && res.write(chunk)) {
          sent += 1;
        }
        if (sent < 200 && !res.destroyed) {
          res.once('drain', push);
        } else {
          res.end(']');
        }
      };
      res.on('close', () => {
        srv.chunkedSent = sent;
      });
      push();
      return;
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  srv.baseUrl = `http://127.0.0.1:${server.address().port}${PATH}`;
  srv.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return srv;
}

/** A new CFIA sheet, shaped like the real ones. */
export function newRecord(nid, fields = {}) {
  return {
    NID: String(nid),
    Title: `Test brand Maple Cookies recalled due to undeclared peanut (${nid})`,
    URL: `https://recalls-rappels.canada.ca/en/alert-recall/test-brand-maple-cookies-${nid}`,
    Organization: 'CFIA',
    Product: 'Maple Cookies',
    Issue: 'Peanut',
    'What you should do': 'Do not consume recalled products',
    Category: 'Candy, confectionary, snacks and sweeteners',
    'Recall class': 'Class 1',
    'Last updated': '2026-10-29',
    Archived: '0',
    ...fields,
  };
}
