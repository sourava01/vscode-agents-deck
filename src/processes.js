// The process table, parsed from `ps` and `lsof` output. Parsers take the command output as a string, so they are
// testable without real processes.
const path = require('path');

/**
 * Parses `ps -axo pid=,ppid=,lstart=,args=` into pid -> { ppid, startedAt, command, args }. `lstart` is always
 * five words ("Sat Oct 17 14:35:04 2026"); `command` is the basename of the first word of `args`.
 */
function parseProcessTable(stdout) {
  const table = new Map();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[4].trim();
    table.set(Number(m[1]), {
      ppid: Number(m[2]),
      startedAt: Date.parse(m[3]) || 0,
      command: path.basename(args.split(/\s+/)[0] ?? ''),
      args,
    });
  }
  return table;
}

/** Parses `lsof -a -p <pids> -d cwd -Fpn` into pid -> working directory. */
function parseCwds(stdout) {
  const cwds = new Map();
  let pid;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && Number.isInteger(pid) && !cwds.has(pid)) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** The first of a process and its ancestors that `isOwner` accepts, if any. */
function findOwner(pid, table, isOwner) {
  const seen = new Set();
  for (let p = pid; p > 1 && !seen.has(p); p = table.get(p)?.ppid) {
    if (isOwner(p)) return p;
    seen.add(p);
  }
  return undefined;
}

// EPERM means the process exists but belongs to another user.
const isAlive = (pid) => {
  try {
    return process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
};

module.exports = { parseProcessTable, parseCwds, findOwner, isAlive };
