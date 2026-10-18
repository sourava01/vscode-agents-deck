// Each harness adapter against fixture files in a throwaway home folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createClaude, projectDir } = require('../src/harnesses/claude');
const { createCodex, jwtClaims, limitLabel, planLabel, codexUsage } = require('../src/harnesses/codex');
const { createPi, sessionDir } = require('../src/harnesses/pi');
const { tempHome, id, jsonl, write } = require('./helpers');

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const iso = (t) => new Date(t).toISOString();

// ---- Claude Code ----

const claudePrompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const claudeReply = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const claudeTool = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });

test('claude: live sessions from the registry, with transcript details and background sessions', () => {
  const home = tempHome();
  const cwd = '/work/app';
  write(path.join(home, '.claude/sessions/1.json'), JSON.stringify({ pid: process.pid, sessionId: id(1), cwd, status: 'busy', startedAt: 5, statusUpdatedAt: 9 }));
  write(path.join(home, '.claude/sessions/2.json'), JSON.stringify({ pid: process.pid, sessionId: id(2), cwd, kind: 'bg', jobId: 'abcd1234', name: 'fork task' }));
  write(path.join(home, '.claude/sessions/3.json'), JSON.stringify({ pid: process.pid, sessionId: '../etc', cwd }));
  write(path.join(home, '.claude/sessions/4.json'), JSON.stringify({ pid: 2 ** 22 + 1, sessionId: id(4), cwd }));
  write(path.join(home, '.claude/sessions/5.json'), '{ broken');
  write(path.join(home, '.claude/sessions/6.json'), JSON.stringify({ pid: process.pid, sessionId: id(6), cwd, kind: 'bg', jobId: 'feedf00d', spare: true }));
  write(path.join(home, '.claude/sessions/7.json'), JSON.stringify({ pid: process.pid, sessionId: id(7), cwd, entrypoint: 'claude-vscode' })); // panel opened, nothing sent
  write(path.join(projectDir(home, cwd), `${id(1)}.jsonl`), jsonl(
    claudePrompt('fix   the login'), { type: 'ai-title', aiTitle: 'Login fix' }, claudeTool('Bash', { description: 'Run tests' }), claudeReply('Running **now**.')));

  const [one, two] = createClaude({ home }).live();
  assert.deepEqual(one, {
    sessionId: id(1), pid: process.pid, cwd, title: 'Login fix', status: 'busy', waitingFor: undefined, statusSince: 9, startedAt: 5, lastInputAt: 5,
    tool: { name: 'Bash', detail: 'Run tests' }, reply: 'Running now.', background: false, attach: undefined, forkedFrom: undefined, chatTab: false,
  });
  assert.equal(two.title, 'fork task');
  assert.equal(two.attach, 'claude attach abcd1234');
  assert.equal(createClaude({ home }).live().length, 2, 'bad, dead, spare and unused panel entries are skipped');
  write(path.join(projectDir(home, cwd), `${id(7)}.jsonl`), jsonl(claudePrompt('hello')));
  assert.equal(createClaude({ home }).live().find((s) => s.sessionId === id(7))?.chatTab, true, 'a chat panel session shows once used');
});

test('claude: a forked background session names its parent from the lines copied into its transcript', () => {
  const home = tempHome();
  const cwd = '/work/app';
  const line = (record, sessionId, ownId = id(3)) => ({ ...record, session_id: sessionId, sessionId: ownId });
  write(path.join(home, '.claude/sessions/1.json'), JSON.stringify({ pid: process.pid, sessionId: id(3), cwd, kind: 'bg', jobId: 'abcd1234' }));
  write(path.join(home, '.claude/sessions/2.json'), JSON.stringify({ pid: process.pid, sessionId: id(4), cwd, kind: 'bg', jobId: 'feed1234' }));
  write(path.join(projectDir(home, cwd), `${id(3)}.jsonl`), jsonl(
    line(claudePrompt('grandparent work'), id(1)),
    // A tool result naming yet another session comes before the line's own session_id.
    line({ ...claudePrompt('parent work'), toolUseResult: { session_id: id(9) } }, id(2)),
    line(claudePrompt('fork work'), id(3))));
  write(path.join(projectDir(home, cwd), `${id(4)}.jsonl`), jsonl(line(claudePrompt('started with --bg'), id(4), id(4))));

  const byId = new Map(createClaude({ home }).live().map((s) => [s.sessionId, s]));
  assert.equal(byId.get(id(3)).forkedFrom, id(2));
  assert.equal(byId.get(id(4)).forkedFrom, undefined, 'not a fork');
});

test('claude: transcript title precedence, stale tools, and closed sessions', () => {
  const home = tempHome();
  const cwd = '/work/app';
  const file = write(path.join(projectDir(home, cwd), `${id(1)}.jsonl`), jsonl(claudeTool('Bash', { command: 'ls' }), claudePrompt('next task')), NOW - DAY);
  write(path.join(projectDir(home, cwd), `${id(2)}.jsonl`), jsonl(claudePrompt('old')), NOW - 10 * DAY);
  write(path.join(projectDir(home, cwd), `${id(3)}.jsonl`), jsonl({ type: 'summary' }), NOW);
  write(path.join(projectDir(home, cwd), 'notes.jsonl'), jsonl(claudePrompt('not a session')), NOW);
  const claude = createClaude({ home });

  const closed = claude.closed({ roots: [cwd], since: NOW - 7 * DAY, live: new Set() });
  assert.deepEqual(closed.map((s) => [s.title, s.resume]), [['next task', `claude --resume ${id(1)}`]]);
  assert.deepEqual(claude.closed({ roots: [cwd], since: 0, live: new Set([id(1)]) }).map((s) => s.title), ['old'], 'running sessions are left out');

  fs.appendFileSync(file, jsonl({ type: 'custom-title', customTitle: 'My name' }));
  assert.equal(claude.closed({ roots: [cwd], since: 0, live: new Set() }).find((s) => s.sessionId === id(1)).title, 'My name');
});

test('claude: slash and shell commands title as typed; messages Claude Code adds are not prompts', () => {
  const home = tempHome();
  const cwd = '/work/app';
  const claude = createClaude({ home });
  const titleOf = (n, ...records) => {
    write(path.join(projectDir(home, cwd), `${id(n)}.jsonl`), jsonl(...records), NOW);
    return claude.closed({ roots: [cwd], since: 0, live: new Set() }).find((s) => s.sessionId === id(n))?.title;
  };
  assert.equal(titleOf(1, claudePrompt('<command-message>doctor</command-message>\n<command-name>/doctor</command-name>\n<command-args></command-args>')), '/doctor');
  assert.equal(titleOf(2, claudePrompt('<command-name>/review</command-name>\n  <command-message>review</command-message>\n  <command-args>PR 12</command-args>')), '/review PR 12');
  assert.equal(titleOf(3, claudePrompt('<bash-input>git status</bash-input>')), '! git status');
  assert.equal(titleOf(4, claudePrompt('<b>bold</b> is not a command')), '<b>bold</b> is not a command');
  assert.equal(titleOf(5,
    claudePrompt('real prompt'),
    { ...claudePrompt('Another Claude session sent a message: hi'), isMeta: true },
    claudePrompt('<local-command-stdout>done</local-command-stdout>'),
    claudePrompt('<bash-stdout>ok</bash-stdout>'),
    claudePrompt('<task-notification>\n<task-id>1</task-id></task-notification>'),
    claudePrompt('<system-reminder>note</system-reminder>')), 'real prompt');
  assert.equal(titleOf(6, { ...claudePrompt('caveat'), isMeta: true }), undefined, 'a session with only added messages is unused');
});

test('claude: account and usage limits, and bad input', () => {
  const home = tempHome();
  write(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { displayName: 'Ada', emailAddress: 'ada@example.com', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' },
    cachedUsageUtilization: { fetchedAtMs: 1234, utilization: { limits: [
      { kind: 'session', percent: 6, resets_at: '2030-01-01T00:00:00Z' },
      { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_all', percent: 'n/a' },
    ] } },
  }));
  assert.deepEqual(createClaude({ home }).account(), {
    name: 'Ada', email: 'ada@example.com', plan: 'Max 20x', updatedAt: 1234,
    limits: [{ label: 'Session', percent: 6, resetsAt: Date.parse('2030-01-01T00:00:00Z') }, { label: 'Weekly · Fable', percent: 0, resetsAt: undefined }],
    note: undefined,
  });
  assert.equal(createClaude({ home: tempHome() }).account(), undefined);
});

test('claude: plans without Fable, with usage credits, and with no limits', () => {
  const home = tempHome();
  const accountWith = (organizationType, utilization) => {
    write(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationType }, cachedUsageUtilization: { fetchedAtMs: 1, utilization } }));
    return createClaude({ home }).account();
  };
  const pro = accountWith('claude_pro', { limits: [{ kind: 'session', percent: 3 }, { kind: 'weekly_all', percent: 1 }] });
  assert.deepEqual(pro.limits.map((l) => l.label), ['Session', 'Weekly'], 'no Fable row when the plan has no Fable limit');
  const credits = accountWith('claude_team', { limits: [], spend: { enabled: true, percent: 25, used: { amount_minor: 2500, currency: 'USD', exponent: 2 }, limit: { amount_minor: 10000, currency: 'USD', exponent: 2 } } });
  assert.deepEqual(credits.limits, [{ label: 'Usage credits', percent: 25, detail: '$25.00 of $100.00' }]);
  assert.equal(credits.note, undefined);
  const extra = accountWith('claude_max', { extra_usage: { is_enabled: true, used_credits: 150, monthly_limit: null, utilization: null, currency: 'USD' } });
  assert.deepEqual(extra.limits, [{ label: 'Usage credits', percent: 0, detail: '$1.50 of no limit' }]);
  const enterprise = accountWith('claude_enterprise', { five_hour: null, seven_day: null, limits: [], spend: { enabled: false } });
  assert.equal(enterprise.plan, 'Enterprise');
  assert.deepEqual(enterprise.limits, []);
  assert.equal(enterprise.note, 'No usage limits reported for this plan.');
});

test('claude: refreshAccount runs claude to fetch usage at most every 5 minutes, and hides that process', async () => {
  const home = tempHome();
  const log = path.join(home, 'calls');
  // A stand-in for `claude`: records its arguments, registers as a session, and answers the get_usage request.
  const fake = write(path.join(home, 'fake-claude'), `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
fs.writeFileSync(${JSON.stringify(path.join(home, '.claude/sessions/helper.json'))}, JSON.stringify({ pid: process.pid, sessionId: '${id(9)}', cwd: '/tmp' }));
process.stdin.once('data', (line) => {
  const { request_id } = JSON.parse(line);
  const response = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(home, 'answer.json'))}, 'utf8'));
  setTimeout(() => console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response } })), 1000);
});
process.stdin.on('end', () => process.exit(0));
`);
  fs.chmodSync(fake, 0o755);
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  write(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: {}, cachedUsageUtilization: { fetchedAtMs: NOW - 10 * 60 * 1000 } }));
  write(path.join(home, 'answer.json'), JSON.stringify({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { limits: [{ kind: 'session', percent: 12 }], model_scoped: [] } }));
  const claude = createClaude({ home, claudeCommands: [path.join(home, 'missing'), fake] });

  const fetching = claude.refreshAccount();
  assert.equal(claude.refreshAccount(), undefined, 'one fetch at a time');
  while (!fs.existsSync(path.join(home, '.claude/sessions/helper.json'))) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(claude.live(), [], 'the helper is not an agent');
  assert.equal(await fetching, true, 'falls back past a missing command');
  assert.match(fs.readFileSync(log, 'utf8'), /--no-session-persistence/);
  assert.equal(claude.refreshAccount(), undefined, 'tried less than 5 minutes ago');
  const { plan, limits, note } = claude.account();
  assert.deepEqual({ plan, limits, note }, { plan: 'Pro', limits: [{ label: 'Session', percent: 12, resetsAt: undefined }], note: undefined }, 'the answer beats the saved copy');

  write(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: {}, cachedUsageUtilization: { fetchedAtMs: NOW } }));
  assert.equal(createClaude({ home, claudeCommands: [fake] }).refreshAccount(), undefined, 'fresh enough already');

  // An API key (or Bedrock, Vertex) login: no account in ~/.claude.json and no plan limits.
  write(path.join(home, '.claude.json'), JSON.stringify({}));
  write(path.join(home, 'answer.json'), JSON.stringify({ subscription_type: null, rate_limits_available: false, rate_limits: null }));
  const api = createClaude({ home, claudeCommands: [fake] });
  assert.equal(api.account(), undefined, 'nothing to show before the first answer');
  assert.equal(await api.refreshAccount(), true);
  assert.deepEqual(api.account(), { name: '', email: '', plan: 'API', limits: [], note: 'No plan limits: usage is billed per token.' });
  assert.equal(await createClaude({ home: tempHome(), claudeCommands: [] }).refreshAccount(), false, 'claude not installed');
});

// ---- Codex ----

const dayDir = (home, t) => {
  const d = new Date(t);
  return path.join(home, '.codex/sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
};
const meta = (n, cwd, t, extra = {}) => ({ timestamp: iso(t), type: 'session_meta', payload: { id: id(n), cwd, timestamp: iso(t), originator: 'codex-tui', base_instructions: { text: 'x'.repeat(100000) }, ...extra } });
const event = (t, payload) => ({ timestamp: iso(t), type: 'event_msg', payload });
const item = (t, payload) => ({ timestamp: iso(t), type: 'response_item', payload });

function codexRollout(home, n, cwd, start, lines, mtime = start) {
  return write(path.join(dayDir(home, start), `rollout-x-${id(n)}.jsonl`), jsonl(meta(n, cwd, start), ...lines), mtime);
}

test('codex: status from events, tool calls, reply, and stale tools', () => {
  const home = tempHome();
  const t = NOW - 60000;
  const file = codexRollout(home, 1, '/work/app', t, [
    event(t + 1, { type: 'user_message', message: 'add a  test' }),
    event(t + 2, { type: 'task_started' }),
    item(t + 3, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }) }),
  ]);
  const table = new Map([[50, { ppid: 1, startedAt: t - 1000, command: 'codex', args: 'codex' }], [51, { ppid: 1, startedAt: t, command: 'codex', args: '/x/app-server-daemon/codex app-server' }]]);
  const cwds = new Map([[50, '/work/app'], [51, '/work/app']]);
  const codex = createCodex({ home });

  let [agent] = codex.live({ table, cwds });
  assert.equal(codex.live({ table, cwds }).length, 1, 'the app-server is not an agent');
  assert.deepEqual([agent.sessionId, agent.title, agent.status, agent.tool], [id(1), 'add a test', 'busy', { name: 'exec_command', detail: 'npm test' }]);

  fs.appendFileSync(file, jsonl(event(t + 4, { type: 'exec_approval_request', command: ['rm', 'x'] })));
  [agent] = codex.live({ table, cwds });
  assert.deepEqual([agent.status, agent.waitingFor], ['waiting', 'Approve command']);

  fs.appendFileSync(file, jsonl(item(t + 5, { type: 'function_call_output' }), event(t + 6, { type: 'agent_message', message: 'All green.' }), event(t + 7, { type: 'task_complete' })));
  [agent] = codex.live({ table, cwds });
  assert.deepEqual([agent.status, agent.reply, agent.statusSince, agent.lastInputAt], ['idle', 'All green.', t + 7, t + 1]);

  fs.appendFileSync(file, jsonl(event(t + 8, { type: 'user_message', message: 'next' })));
  assert.equal(codex.live({ table, cwds })[0].tool, undefined, 'a tool from before the latest prompt is stale');
});

test('codex: matching processes to rollouts, titles from the index, subagents and closed sessions', () => {
  const home = tempHome();
  const t = NOW - 60000;
  codexRollout(home, 1, '/work/app', t - 5 * 60000, [event(t, { type: 'user_message', message: 'older run' })]); // before the process started
  codexRollout(home, 2, '/work/app', t + 1000, [event(t, { type: 'user_message', message: 'current run' })]);
  write(path.join(dayDir(home, t), `rollout-x-${id(3)}.jsonl`), jsonl({ ...meta(3, '/work/app', t + 2000, { source: { subagent: {} } }) }, event(t, { type: 'user_message', message: 'sub' })), t + 2000);
  write(path.join(home, '.codex/session_index.jsonl'), jsonl({ id: id(2), thread_name: 'Named thread' }, 'garbage'));
  const table = new Map([[50, { ppid: 1, startedAt: t, command: 'codex', args: 'codex' }], [60, { ppid: 1, startedAt: t, command: 'codex', args: 'codex' }]]);
  const codex = createCodex({ home });

  const [agent, fresh] = codex.live({ table, cwds: new Map([[50, '/work/app'], [60, '/work/other']]) });
  assert.deepEqual([agent.sessionId, agent.title], [id(2), 'Named thread']);
  assert.deepEqual([fresh.sessionId, fresh.title, fresh.status], [undefined, 'New session', 'idle'], 'no transcript until the first prompt');

  const closed = codex.closed({ roots: ['/work/app'], since: NOW - 7 * DAY, live: new Set([id(2)]) });
  assert.deepEqual(closed.map((s) => [s.title, s.resume]), [['older run', `codex resume ${id(1)}`]], 'subagents and running sessions are left out');
});

test('codex: prompts and replies recorded as messages (Codex 0.163), skipping injected context', () => {
  const home = tempHome();
  const t = NOW - 60000;
  const msg = (role, type, text) => item(t, { type: 'message', role, content: [{ type, text }] });
  codexRollout(home, 1, '/work/app', t - DAY, [
    msg('developer', 'input_text', '<permissions instructions>...'),
    msg('user', 'input_text', '<environment_context>\n  <cwd>/work/app</cwd>'),
    msg('user', 'input_text', 'why is the model reset?'),
    item(t, { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n...' }),
    msg('assistant', 'output_text', 'A workspace policy sets it.'),
  ], t - DAY);
  const [session] = createCodex({ home }).closed({ roots: ['/work/app'], since: NOW - 7 * DAY, live: new Set() });
  assert.deepEqual([session.title, session.reply], ['why is the model reset?', 'A workspace policy sets it.']);
});

test('codex: account from the ID token, rate limits, and bad input', () => {
  const home = tempHome();
  const claims = { name: 'Ada', email: 'ada@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } };
  const token = ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  write(path.join(home, '.codex/auth.json'), JSON.stringify({ tokens: { id_token: token, access_token: 'secret' } }));
  codexRollout(home, 1, '/w', NOW - 1000, [event(NOW, { type: 'token_count', rate_limits: {
    primary: { used_percent: 42, window_minutes: 300, resets_at: 2000000000 }, secondary: { used_percent: 7, window_minutes: 10080 } } })]);

  assert.deepEqual(createCodex({ home }).account(), {
    name: 'Ada', email: 'ada@example.com', plan: 'Plus',
    limits: [{ label: '5h', percent: 42, resetsAt: 2000000000000 }, { label: 'Weekly', percent: 7, resetsAt: undefined }],
    note: undefined,
  });
  assert.equal(jwtClaims('not-a-jwt'), undefined);
  assert.equal(limitLabel(undefined), 'Limit');
  write(path.join(home, '.codex/auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-secret' }));
  assert.deepEqual(createCodex({ home }).account(), { name: '', email: '', plan: 'API key', limits: [], note: 'No plan limits: usage is billed per token.' });
  write(path.join(home, '.codex/auth.json'), '{}');
  assert.equal(createCodex({ home }).account(), undefined, 'signed out');
});

test('codex: plans paid with credits, spend limits, and plan names', () => {
  // A business plan as Codex records it: no time windows, workspace credits.
  const business = { limit_id: 'codex', primary: null, secondary: null, credits: { has_credits: true, unlimited: false, balance: null }, individual_limit: null, spend_control_reached: null, plan_type: 'business', rate_limit_reached_type: null };
  assert.deepEqual(codexUsage(business), { limits: [], note: 'No usage limits: usage is paid with credits.' });
  assert.equal(codexUsage({ ...business, credits: { has_credits: true, unlimited: true, balance: null } }).note, 'Unlimited credits.');
  assert.equal(codexUsage({ ...business, credits: { has_credits: true, unlimited: false, balance: '120' } }).note, 'Credits: 120');
  assert.equal(codexUsage({ ...business, rate_limit_reached_type: 'workspace_member_credits_depleted' }).note, 'Workspace credits used up. Ask your workspace owner for more.');
  assert.deepEqual(codexUsage({ ...business, individual_limit: { limit: '$50', used: '$40', remaining_percent: 20, resets_at: 2000000000 } }), {
    limits: [{ label: 'Spend limit', percent: 80, detail: '$40 of $50', resetsAt: 2000000000000 }], note: undefined,
  });
  assert.deepEqual(codexUsage(undefined), { limits: [], note: undefined }, 'no rate limits recorded yet');
  assert.deepEqual(['plus', 'prolite', 'self_serve_business_usage_based', 'enterprise_cbp_automation', 'edu_plus', 'new_plan'].map(planLabel),
    ['Plus', 'Pro Lite', 'Business', 'Enterprise', 'Edu', 'New Plan']);
});

// ---- pi ----

const piMessage = (t, message) => ({ type: 'message', timestamp: iso(t), message });

test('pi: folder naming, status, tools, names, live matching and closed sessions', () => {
  assert.equal(path.basename(sessionDir('/h', '/Users/a.b/Work/credstash-v3')), '--Users-a.b-Work-credstash-v3--');
  const home = tempHome();
  const cwd = '/work/app';
  const t = NOW - 60000;
  const dir = sessionDir(home, cwd);
  const file = write(path.join(dir, 'b.jsonl'), jsonl(
    { type: 'session', version: 3, id: id(2), cwd },
    piMessage(t + 1, { role: 'user', content: [{ type: 'text', text: 'write docs' }] }),
    piMessage(t + 2, { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }], stopReason: 'toolUse' }),
  ), t + 2);
  write(path.join(dir, 'a.jsonl'), jsonl({ type: 'session', id: id(1), cwd }, piMessage(t, { role: 'user', content: 'old task' })), t - 60000);
  const table = new Map([[70, { ppid: 1, startedAt: t, command: 'pi', args: 'pi' }]]);
  const cwds = new Map([[70, cwd]]);
  const pi = createPi({ home });

  let [agent] = pi.live({ table, cwds });
  assert.deepEqual([agent.sessionId, agent.title, agent.status, agent.tool, agent.lastInputAt], [id(2), 'write docs', 'busy', { name: 'bash', detail: 'ls' }, t + 1]);

  fs.appendFileSync(file, jsonl(
    piMessage(t + 3, { role: 'toolResult', toolName: 'bash', content: [] }),
    piMessage(t + 4, { role: 'assistant', content: [{ type: 'text', text: 'Docs **written**.' }], stopReason: 'stop' }),
    { type: 'session_info', name: 'Docs pass' }, 'not json'));
  [agent] = pi.live({ table, cwds });
  assert.deepEqual([agent.title, agent.status, agent.reply, agent.statusSince], ['Docs pass', 'idle', 'Docs written.', t + 4]);

  const closed = pi.closed({ roots: [cwd], since: NOW - 7 * DAY, live: new Set([id(2)]) });
  assert.deepEqual(closed.map((s) => [s.title, s.resume]), [['old task', `pi --session ${id(1)}`]]);
  assert.equal(pi.account(), undefined);
});
