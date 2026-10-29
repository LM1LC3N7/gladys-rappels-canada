// -----------------------------------------------------------------------------
// A streaming reader of a JSON array of objects, `[{...},{...}]`, fed by
// chunks of text: it hands each element to `onObject` as soon as its closing
// brace arrives, so the memory used is one element, never the whole file
// (the open data file of Health Canada weighs 16 MB in English, 21 MB in
// French, 34,000 sheets). One pass, linear in the size of the input.
//
// Only the frame is scanned here (strings, escapes, braces, brackets); each
// element is then parsed by JSON.parse, which checks it fully. An element
// longer than `maxObjectBytes` is skipped, not buffered (counted in
// `skipped`); anything but an array of objects at the top level is an error.
// -----------------------------------------------------------------------------

export class JsonArrayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonArrayError';
  }
}

const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

export class JsonArrayReader {
  /**
   * @param {object} options
   * @param {(value: object) => void} options.onObject called with each element
   * @param {number} [options.maxObjectBytes] characters kept for one element
   */
  constructor({ onObject, maxObjectBytes = 64 * 1024 }) {
    this.onObject = onObject;
    this.maxObjectBytes = maxObjectBytes;
    // 'start' (before '['), 'between' (expecting an element or ']'),
    // 'after' (after an element: ',' or ']'), 'object', 'end'.
    this.state = 'start';
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.parts = [];
    this.length = 0;
    this.oversized = false;
    this.count = 0;
    this.skipped = 0;
  }

  /** Feed the next chunk of text. */
  write(text) {
    let i = 0;
    const n = text.length;
    while (i < n) {
      if (this.state === 'object') {
        i = this.scanObject(text, i);
        continue;
      }
      const c = text[i];
      i += 1;
      if (isSpace(c)) {
        continue;
      }
      if (this.state === 'start') {
        if (c !== '[') {
          throw new JsonArrayError('not a JSON array');
        }
        this.state = 'between';
      } else if (this.state === 'between' || this.state === 'after') {
        if (c === ']' && (this.state === 'after' || this.count + this.skipped === 0)) {
          this.state = 'end';
        } else if (c === ',' && this.state === 'after') {
          this.state = 'between';
        } else if (c === '{' && this.state === 'between') {
          this.state = 'object';
          this.depth = 1;
          this.parts = ['{'];
          this.length = 1;
          this.oversized = false;
        } else {
          throw new JsonArrayError(`unexpected "${c}" between the elements`);
        }
      } else {
        throw new JsonArrayError('data after the end of the array');
      }
    }
  }

  /** Scan an element from `start`; returns the index after what was consumed. */
  scanObject(text, start) {
    let i = start;
    const n = text.length;
    for (; i < n; i += 1) {
      const c = text[i];
      if (this.inString) {
        if (this.escape) {
          this.escape = false;
        } else if (c === '\\') {
          this.escape = true;
        } else if (c === '"') {
          this.inString = false;
        }
        continue;
      }
      if (c === '"') {
        this.inString = true;
      } else if (c === '{' || c === '[') {
        this.depth += 1;
      } else if (c === '}' || c === ']') {
        this.depth -= 1;
        if (this.depth === 0) {
          if (c !== '}') {
            throw new JsonArrayError('unbalanced element');
          }
          this.keep(text, start, i + 1);
          this.finish();
          return i + 1;
        }
      }
    }
    this.keep(text, start, n);
    return n;
  }

  keep(text, from, to) {
    if (this.oversized || to <= from) {
      return;
    }
    this.length += to - from;
    if (this.length > this.maxObjectBytes) {
      this.oversized = true;
      this.parts = [];
      return;
    }
    this.parts.push(text.slice(from, to));
  }

  finish() {
    this.state = 'after';
    if (this.oversized) {
      this.skipped += 1;
      this.parts = [];
      return;
    }
    let value;
    try {
      value = JSON.parse(this.parts.join(''));
    } catch {
      throw new JsonArrayError('an element is not valid JSON');
    }
    this.parts = [];
    this.count += 1;
    this.onObject(value);
  }

  /** The input is over: throws unless the array was closed. */
  end() {
    if (this.state !== 'end') {
      throw new JsonArrayError('the array is cut short');
    }
  }
}
