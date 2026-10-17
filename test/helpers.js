// Fixtures shared by the tests: a throwaway home folder and JSON Lines writers.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-deck-test-'));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jsonl = (...records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

function write(file, content, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime !== undefined) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

/** `ps -axo pid=,ppid=,lstart=,args=` output for the given processes. */
const psOutput = (procs) => procs.map(({ pid, ppid, start, args }) => {
  const d = new Date(start);
  const lstart = d.toString().replace(/^(\w+) (\w+) (\d+) (\d+) ([\d:]+).*$/, '$1 $2 $3 $5 $4');
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${lstart}     ${args}`;
}).join('\n');

module.exports = { tempHome, id, jsonl, write, psOutput };
