// Small file and text helpers shared by the harness adapters. Every reader tolerates missing or malformed input.
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

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

const CHUNK_BYTES = 1024 * 1024;

/**
 * Follows JSON Lines files that only grow. The first read of a file feeds every line to `scan(line, state)`; later
 * reads feed only what was appended, so polling a large transcript stays cheap. `summarize(state)` turns the
 * accumulated state into the details the panel shows. Files are read in 1 MB chunks, so only the line being read sits
 * in memory whole, not the transcript.
 */
class JsonlFollower {
  #files = new Map(); // file -> { size, rest, decoder, state, info }; rest holds the pieces of an unfinished line

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
      // The decoder holds back a character split between two reads until its other bytes arrive.
      f = { size: 0, rest: [], decoder: new StringDecoder('utf8'), state, info: this.summarize(state) };
      this.#files.set(file, f);
    }
    if (size === f.size) return f.info;

    const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - f.size));
    const fd = fs.openSync(file, 'r');
    try {
      while (f.size < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - f.size), f.size);
        if (n === 0) break; // cut short since the size was taken
        f.size += n;
        // A half-written last line waits for the next chunk or read. Its pieces are joined once it ends, so a line
        // longer than a chunk is copied once, not once per chunk.
        const text = f.decoder.write(buf.subarray(0, n));
        const end = text.lastIndexOf('\n');
        f.rest.push(end === -1 ? text : text.slice(0, end));
        if (end === -1) continue;
        const lines = f.rest.join('').split('\n');
        f.rest = [text.slice(end + 1)];
        for (const line of lines) if (line) this.scan(line, f.state);
      }
    } finally {
      fs.closeSync(fd);
    }
    f.info = this.summarize(f.state);
    return f.info;
  }
}

module.exports = { UUID, parseJson, readJson, readDir, mtimeOf, oneLine, timeOf, plainText, toolDetail, within, firstLine, JsonlFollower };
