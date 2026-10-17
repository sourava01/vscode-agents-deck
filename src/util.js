// Small file and text helpers shared by the harness adapters. Every reader tolerates missing or malformed input.
const fs = require('fs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
const readDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const mtimeOf = (file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
const oneLine = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');
const timeOf = (iso) => Date.parse(iso) || undefined;

/** A Markdown reply as plain text, for a one-line preview. */
const plainText = (markdown) => oneLine(String(markdown ?? '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
  .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, '$2')
  .replace(/\|/g, ' '));

/** The most useful one-line description of a tool call's input. */
function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  const detail = input.questions?.[0]?.question ?? input.description ?? input.command ?? input.cmd
    ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.prompt;
  return oneLine(Array.isArray(detail) ? detail.join(' ') : detail).slice(0, 160);
}

/** The promise's value, or `fallback` if it hasn't settled within `ms` (or fails). */
function within(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms, fallback); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/** The first line of a file, read in chunks so a long first line (e.g. embedded instructions) still parses. */
function firstLine(file, maxBytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let read = 0; read < maxBytes;) {
      const n = fs.readSync(fd, buf, 0, buf.length, read);
      if (n === 0) break;
      const end = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, end === -1 ? n : end)));
      if (end !== -1) break;
      read += n;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Follows JSON Lines files that only grow. The first read of a file feeds every line to `scan(line, state)`; later
 * reads feed only what was appended, so polling a large transcript stays cheap. `summarize(state)` turns the
 * accumulated state into the details the panel shows.
 */
class JsonlFollower {
  #files = new Map(); // file -> { size, rest, state, info }

  constructor({ initialState, scan, summarize }) {
    this.initialState = initialState;
    this.scan = scan;
    this.summarize = summarize;
  }

  read(file) {
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size;
    if (size === undefined) return undefined;
    let f = this.#files.get(file);
    if (!f || size < f.size) { // new, or rewritten in place
      const state = this.initialState();
      f = { size: 0, rest: '', state, info: this.summarize(state) };
      this.#files.set(file, f);
    }
    if (size === f.size) return f.info;

    // ponytail: reads the new bytes in one buffer; read in chunks if transcripts grow past a few hundred MB.
    const buf = Buffer.alloc(size - f.size);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, f.size);
    } finally {
      fs.closeSync(fd);
    }
    const lines = (f.rest + buf.toString('utf8')).split('\n');
    f.rest = lines.pop(); // a half-written last line waits for the next read
    f.size = size;
    for (const line of lines) if (line) this.scan(line, f.state);
    f.info = this.summarize(f.state);
    return f.info;
  }
}

module.exports = { UUID, parseJson, readJson, readDir, mtimeOf, oneLine, timeOf, plainText, toolDetail, within, firstLine, JsonlFollower };
