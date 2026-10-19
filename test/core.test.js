// Shared pieces: process table, JSONL following, text helpers, settings, ordering, search, and the Completed marker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseProcessTable, parseCwds, findOwner } = require('../src/processes');
const { plainText, toolDetail, within, firstLine, JsonlFollower } = require('../src/util');
const { readConfig } = require('../src/config');
const { chatTabMatches, byStatus, searchClosed, CompletionTracker, MoveTracker, foldSubAgents } = require('../src/agents');
const { tempHome, write, psOutput } = require('./helpers');

test('parseProcessTable reads start times and command names, skipping malformed lines', () => {
  const start = Date.parse('2026-10-17T14:35:04');
  const table = parseProcessTable(`${psOutput([
    { pid: 10, ppid: 1, start, args: '/opt/homebrew/bin/codex --model gpt' },
    { pid: 20, ppid: 10, start, args: 'pi' },
  ])}\n  30  1 Sat Oct  7 09:01:02 2026  /bin/zsh -il\ngarbage\n`);
  assert.deepEqual(table.get(10), { ppid: 1, startedAt: start, command: 'codex', args: '/opt/homebrew/bin/codex --model gpt' });
  assert.equal(table.get(20).command, 'pi');
  assert.equal(table.get(30).startedAt, Date.parse('2026-10-07T09:01:02'), 'single-digit days are space-padded by ps');
  assert.equal(table.size, 3);
});

test('parseCwds and findOwner', () => {
  assert.deepEqual([...parseCwds('p10\nfcwd\nn/work/a\np20\nfcwd\nn/work/b\nnstray\n')], [[10, '/work/a'], [20, '/work/b']]);
  const table = new Map([[40, { ppid: 30 }], [30, { ppid: 20 }], [20, { ppid: 1 }], [7, { ppid: 8 }], [8, { ppid: 7 }]]);
  assert.equal(findOwner(40, table, (pid) => pid === 20), 20);
  assert.equal(findOwner(40, table, () => false), undefined);
  assert.equal(findOwner(7, table, () => false), undefined, 'stops at a cycle');
});

test('plainText, toolDetail and firstLine', () => {
  assert.equal(plainText('## Done\n\n- **Fixed** the `bug`, see [docs](http://x)\n```js\ncode\n```'), 'Done Fixed the bug, see docs');
  assert.equal(toolDetail({ command: ['git', 'status'] }), 'git status');
  assert.equal(toolDetail({ description: 'Run tests', command: 'npm test' }), 'Run tests');
  assert.equal(toolDetail('not an object'), '');
  const file = write(path.join(tempHome(), 'f.jsonl'), `${'x'.repeat(200000)}\nsecond\n`);
  assert.equal(firstLine(file).length, 200000, 'reads past the first chunk');
  assert.equal(firstLine(path.join(tempHome(), 'missing')), '');
});

test('within: the value if it settles in time, else the fallback', async () => {
  assert.equal(await within(Promise.resolve(7), 50, 'late'), 7);
  assert.equal(await within(new Promise(() => {}), 20, 'late'), 'late', 'a promise that never settles');
  assert.equal(await within(Promise.reject(new Error('x')), 50, 'failed'), 'failed');
});

test('JsonlFollower reads appended lines only, waits for half-written lines, and restarts on rewrite', () => {
  const file = path.join(tempHome(), 't.jsonl');
  const seen = [];
  const follower = new JsonlFollower({ initialState: () => ({ n: 0 }), scan: (line, s) => { s.n++; seen.push(line); }, summarize: (s) => s.n });
  assert.equal(follower.read(file), undefined, 'missing file');
  write(file, 'a\nb\nhalf');
  assert.equal(follower.read(file), 2);
  fs.appendFileSync(file, '-line\nc\n');
  assert.equal(follower.read(file), 4);
  assert.deepEqual(seen, ['a', 'b', 'half-line', 'c']);
  write(file, 'fresh\n');
  assert.equal(follower.read(file), 1);
});

test('readConfig: defaults, and bad values fall back or are clamped', () => {
  assert.deepEqual(readConfig(() => undefined), {
    harnesses: { claude: true, codex: true, pi: true },
    sources: { terminal: true, extension: true, background: true },
    closedMaxAgeDays: 7,
    closedHideShort: true,
    accounts: true,
    refreshMs: 10000,
  });
  const values = { 'harnesses.codex': false, 'sources.background': 'yes', 'closedSessions.maxAgeDays': -3, refreshSeconds: 0.4 };
  const config = readConfig((key) => values[key]);
  assert.equal(config.harnesses.codex, false);
  assert.equal(config.sources.background, true, 'non-boolean falls back to the default');
  assert.equal(config.closedMaxAgeDays, 0);
  assert.equal(config.refreshMs, 2000);
});

test('chatTabMatches, byStatus and searchClosed', () => {
  assert.equal(chatTabMatches('Maximizing terminal in Z…', 'Maximizing terminal in Zed'), true);
  assert.equal(chatTabMatches('Other…', 'Maximizing terminal in Zed'), false);
  assert.equal(chatTabMatches(undefined, 'x'), false);
  const agents = [{ status: 'idle', statusSince: 1 }, { status: 'busy', statusSince: 1 }, { status: 'busy', statusSince: 2 }, { status: 'completed', statusSince: 1 }, { status: 'waiting', statusSince: 1 }, { status: 'busy' }];
  assert.deepEqual(agents.sort(byStatus).map((a) => `${a.status}${a.statusSince ?? ''}`), ['waiting1', 'completed1', 'busy2', 'busy1', 'busy', 'idle1'], 'latest status change first within a status');
  const sessions = [{ title: 'Deploy api', reply: 'Done.', lastActivity: 1 }, { title: 'Fix test', reply: 'Fixed it.', lastActivity: 2 }];
  assert.deepEqual(searchClosed(sessions, '').map((s) => s.title), ['Fix test', 'Deploy api']);
  assert.deepEqual(searchClosed(sessions, '  FIXED ').map((s) => s.title), ['Fix test']);
});

test('CompletionTracker: completed after a turn ends, idle once viewed', () => {
  const tracker = new CompletionTracker();
  const step = (status, viewing = false) => tracker.apply([{ key: 'a', status, viewing }])[0].status;
  const seen = [['busy'], ['idle'], ['idle'], ['idle', true], ['idle'], ['busy', true], ['idle', true], ['waiting'], ['idle']]
    .map(([status, viewing]) => step(status, viewing));
  assert.deepEqual(seen, ['busy', 'completed', 'completed', 'idle', 'idle', 'busy', 'idle', 'waiting', 'completed']);
  assert.equal(tracker.apply([{ key: 'b', status: 'idle' }])[0].status, 'idle', 'an agent first seen idle stays idle');
});

test('MoveTracker: marks sessions that just closed or resumed, for a while', () => {
  const tracker = new MoveTracker(100);
  const keys = (...k) => new Set(k);
  assert.equal(tracker.update(keys('a', 'b'), keys('c'), 0), true, 'first sight counts as joining');
  assert.equal(tracker.moved('a', 'active'), false, 'a new session is not a resumed one');
  assert.equal(tracker.update(keys('a', 'b'), keys('c'), 10), false);
  assert.equal(tracker.update(keys('a', 'c'), keys('c'), 20), true);
  assert.equal(tracker.moved('b', 'closed'), true);
  assert.equal(tracker.moved('c', 'active'), true, 'was in Closed Agents, now running again');
  assert.equal(tracker.update(keys('a', 'c'), keys('b'), 119), false);
  assert.equal(tracker.moved('b', 'closed'), true);
  tracker.update(keys('a', 'c'), keys('b'), 120);
  assert.equal(tracker.moved('b', 'closed'), false, 'the mark expires');
  tracker.update(keys('c'), keys(), 130);
  tracker.update(keys('a', 'c'), keys(), 140);
  assert.equal(tracker.moved('a', 'closed') || tracker.moved('a', 'active'), false, 'briefly hidden and back is no move');
});

test('foldSubAgents: agents started by an agent count on the top-level agent', () => {
  // 10 runs in a terminal; its Bash tool runs a script (11) that starts 12, which starts 13. 20 is a fork run by
  // Claude Code's daemon (19), which 10 started.
  const table = new Map([[10, { ppid: 1 }], [11, { ppid: 10 }], [12, { ppid: 11 }], [13, { ppid: 12 }], [19, { ppid: 10 }], [20, { ppid: 19 }], [30, { ppid: 1 }]]);
  const sessions = [{ pid: 10, workflowAgents: 2 }, { pid: 12 }, { pid: 13 }, { pid: 20, background: true }, { pid: 30 }];
  assert.deepEqual(foldSubAgents(sessions, table).map((s) => [s.pid, s.subAgents]), [[10, 4], [20, 0], [30, 0]]);
});
