// Claude Code. It registers every running session in ~/.claude/sessions/<pid>.json, writes transcripts to
// ~/.claude/projects/<cwd>/<session id>.jsonl, and caches the account and usage limits in ~/.claude.json.
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { UUID, parseJson, readJson, readDir, mtimeOf, oneLine, plainText, toolDetail, JsonlFollower } = require('../util');
const { isAlive } = require('../processes');

// Claude Code names a project's transcript folder after its working directory, with every non-alphanumeric
// character replaced by "-".
const projectDir = (home, cwd) => path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

const NOT_TYPED = /"message":\{"role":"user","content":"<(local-command-[a-z]+|bash-std(out|err)|task-notification|system-reminder)>/;

/** A typed prompt as you typed it: Claude Code records a slash command and a `!` shell command as XML-like tags. */
function promptText(content) {
  const text = oneLine(content);
  if (!/^<(command-(name|message|args)|bash-input)>/.test(text)) return text;
  const tag = (name) => new RegExp(`<${name}>(.*?)</${name}>`).exec(text)?.[1];
  const bash = tag('bash-input');
  if (bash !== undefined) return oneLine(`! ${bash}`);
  const command = tag('command-name') ?? `/${tag('command-message') ?? ''}`;
  return oneLine(`${command} ${tag('command-args') ?? ''}`);
}

// The transcript lines that matter, found with a cheap substring test. Only the latest of each kind is parsed.
const LINE_KINDS = {
  customTitle: (line) => line.includes('"type":"custom-title"'),
  aiTitle: (line) => line.includes('"type":"ai-title"'),
  // A prompt you typed: a user message whose content is a plain string (tool results are arrays). Messages Claude Code
  // adds itself are left out: ones marked isMeta, and command output, task notifications and reminders.
  prompt: (line) => line.includes('"message":{"role":"user","content":"') && !line.includes('"isMeta":true') && !NOT_TYPED.test(line),
  tool: (line) => line.includes('"type":"assistant"') && line.includes('"type":"tool_use"'),
  reply: (line) => line.includes('"type":"assistant"') && line.includes('"type":"text"'),
};

// A session made with /fork starts with a copy of its parent's transcript, and the copied lines keep the parent's ID in
// their "session_id" field (undocumented: if Claude Code drops it, forks are matched by folder only). It's the line's
// last "session_id", since a tool result earlier in the line can contain one too.
const SESSION_ID_FIELD = '"session_id":"';
function sessionIdOf(line) {
  const at = line.lastIndexOf(SESSION_ID_FIELD);
  const id = at === -1 ? '' : line.slice(at + SESSION_ID_FIELD.length, at + SESSION_ID_FIELD.length + 36);
  return UUID.test(id) ? id : undefined;
}

function summarize({ prompts, found: { customTitle, aiTitle, prompt, tool, reply }, sessionIds }) {
  const record = (match) => (match ? parseJson(match.line) : undefined);
  const lastBlock = (match, type) => {
    const content = record(match)?.message?.content;
    return Array.isArray(content) ? content.findLast((block) => block?.type === type) : undefined;
  };
  const toolBlock = lastBlock(tool, 'tool_use');
  return {
    promptAt: Date.parse(record(prompt)?.timestamp) || undefined,
    title: oneLine(record(customTitle)?.customTitle) || oneLine(record(aiTitle)?.aiTitle) || promptText(record(prompt)?.message?.content).slice(0, 80),
    used: Boolean(prompt || customTitle || aiTitle),
    prompts, // how many messages you sent
    // A tool call from before your latest prompt belongs to an earlier turn.
    tool: toolBlock && !(prompt?.seq > tool.seq) ? { name: String(toolBlock.name), detail: toolDetail(toolBlock.input) } : undefined,
    reply: plainText(lastBlock(reply, 'text')?.text).slice(0, 300),
    sessionIds: [...sessionIds], // every session whose lines appear in the transcript, oldest first
  };
}

// Claude Code saves its usage limits only when something asks for them, so every 5 minutes the panel asks: Claude Code's
// SDK mode answers a get_usage request without a model call and saves the result to ~/.claude.json. Without MCP
// servers or a saved transcript, it takes about a second.
const USAGE_REFRESH_MS = 5 * 60 * 1000;
const USAGE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence'];
const USAGE_REQUEST = `${JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } })}\n`;
const USAGE_TIMEOUT_MS = 30000;

/**
 * Runs the first of `commands` that exists to fetch the usage limits; `onStart(pid)` gets its process ID. Resolves to
 * Claude Code's answer (subscription_type, rate_limits_available, rate_limits), or undefined if it didn't answer.
 */
function fetchUsage(commands, onStart) {
  const [command, ...fallbacks] = commands;
  if (!command) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn(command, USAGE_ARGS, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), USAGE_TIMEOUT_MS);
    let answer;
    let rest = '';
    child.on('spawn', () => onStart(child.pid));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(err.code === 'ENOENT' ? fetchUsage(fallbacks, onStart) : undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(answer);
    });
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      const response = lines.map(parseJson).find((m) => m?.type === 'control_response' && m.response?.request_id === 'usage')?.response;
      if (!response) return;
      if (response.subtype === 'success' && response.response && typeof response.response === 'object') answer = response.response;
      child.stdin.end(); // nothing else to ask, so it exits
    });
    child.stdin.on('error', () => {});
    child.stdin.write(USAGE_REQUEST);
  });
}

const USAGE_RETRY_NO_LIMITS_MS = 60 * 60 * 1000; // an API key login has no plan limits to watch

const PLANS = { claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise' };
const SUBSCRIPTIONS = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' }; // get_usage's subscription_type

/** An amount in minor units (cents) as currency, e.g. 1234 USD -> "$12.34". */
function money(minor, currency, exponent = 2) {
  if (!Number.isFinite(minor)) return undefined;
  const value = minor / 10 ** (Number.isInteger(exponent) ? exponent : 2);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'USD') }).format(value);
  } catch {
    return value.toFixed(2);
  }
}
const moneyOf = (m) => (m && typeof m === 'object' ? money(m.amount_minor, m.currency, m.exponent) : undefined);

// The windows a get_usage answer documents: each is { utilization, resets_at }, and model_scoped lists the weekly
// limits for single models such as Fable (empty when the plan has none).
const WINDOWS = { five_hour: 'Session', seven_day: 'Weekly', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };

/**
 * The rows the Accounts section shows for a get_usage answer: the session and weekly limits, then usage credits when
 * they are turned on.
 */
function usageRows(u) {
  const windows = Object.entries(WINDOWS).map(([field, label]) => ({ label, ...u?.[field] }));
  const models = (Array.isArray(u?.model_scoped) ? u.model_scoped : []).map((m) => ({ ...m, label: `Weekly · ${oneLine(m?.display_name) || 'scoped'}` }));
  const rows = [...windows, ...models]
    .filter((w) => Number.isFinite(w.utilization))
    .map((w) => ({ label: w.label, percent: w.utilization, resetsAt: Date.parse(w.resets_at) || undefined }));
  // Usage credits: the newer `spend` block, else the older `extra_usage` one. Both cover usage past the plan limits.
  const spend = u?.spend;
  const extra = u?.extra_usage;
  if (spend?.enabled === true && moneyOf(spend.limit) && Number.isFinite(spend.percent)) {
    rows.push({ label: 'Usage credits', percent: spend.percent, detail: `${moneyOf(spend.used) ?? '?'} of ${moneyOf(spend.limit)}` });
  } else if (extra?.is_enabled === true) {
    const places = Number.isInteger(extra.decimal_places) ? extra.decimal_places : 2;
    const used = money(extra.used_credits, extra.currency, places) ?? '?';
    rows.push({
      label: 'Usage credits',
      percent: Number.isFinite(extra.utilization) ? extra.utilization : 0,
      detail: `${used} of ${money(extra.monthly_limit, extra.currency, places) ?? 'no limit'}`,
    });
  }
  return rows;
}

function createClaude({ home, claudeCommands = ['claude', path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'] }) {
  let usagePid; // the `claude` process fetching usage, which registers itself as a session while it runs
  let usageFetch;
  let usageTriedAt = 0;
  let usage; // the latest get_usage result: { answer } or { failed: true }

  const transcripts = new JsonlFollower({
    initialState: () => ({ seq: 0, prompts: 0, found: {}, sessionIds: new Set() }),
    scan(line, state) {
      state.seq++;
      const id = sessionIdOf(line);
      if (id) state.sessionIds.add(id);
      for (const [kind, matches] of Object.entries(LINE_KINDS)) {
        if (!matches(line)) continue;
        state.found[kind] = { line, seq: state.seq };
        if (kind === 'prompt') state.prompts++;
      }
    },
    summarize,
  });
  const transcript = (cwd, sessionId) => transcripts.read(path.join(projectDir(home, cwd), `${sessionId}.jsonl`)) ?? {};

  function registeredSessions() {
    const dir = path.join(home, '.claude', 'sessions');
    return readDir(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(dir, name)))
      .filter((s) => Number.isInteger(s?.pid) && UUID.test(s.sessionId) && typeof s.cwd === 'string' && isAlive(s.pid));
  }

  return {
    id: 'claude',
    label: 'Claude',
    wantsCwd: () => false, // the registry already names each session's folder

    live() {
      return registeredSessions().flatMap((s) => {
        if (s.pid === usagePid) return [];
        const info = transcript(s.cwd, s.sessionId);
        // Not agents yet: spare processes Claude Code starts ahead of time, and the process the Claude Code
        // extension starts when you open its panel, before you've sent anything.
        if (s.spare === true || (s.entrypoint === 'claude-vscode' && !info.used)) return [];
        // Background sessions (from /fork or --bg) run in Claude Code's own background process, not a terminal.
        const background = s.kind === 'bg' && /^[0-9a-f]{8}$/.test(s.jobId);
        return [{
          sessionId: s.sessionId,
          pid: s.pid,
          cwd: s.cwd,
          title: info.title || oneLine(s.name) || 'Untitled session',
          status: s.waitingFor ? 'waiting' : s.status === 'busy' ? 'busy' : 'idle',
          waitingFor: oneLine(s.waitingFor) || undefined,
          statusSince: s.statusUpdatedAt,
          startedAt: s.startedAt ?? 0,
          lastInputAt: info.promptAt ?? s.startedAt ?? 0,
          tool: info.tool,
          reply: info.reply,
          background,
          attach: background ? `claude attach ${s.jobId}` : undefined,
          forkedFrom: background ? info.sessionIds?.findLast((id) => id !== s.sessionId) : undefined, // a fork's parent
          chatTab: s.entrypoint === 'claude-vscode', // runs in the Claude Code extension's chat
        }];
      });
    },

    closed({ roots, since, live }) {
      return roots.flatMap((root) => {
        const dir = projectDir(home, root);
        return readDir(dir).flatMap((name) => {
          const sessionId = name.slice(0, -'.jsonl'.length);
          if (!name.endsWith('.jsonl') || !UUID.test(sessionId) || live.has(sessionId)) return [];
          const lastActivity = mtimeOf(path.join(dir, name));
          if (!(lastActivity >= since)) return [];
          const info = transcript(root, sessionId);
          return info.used ? [{ sessionId, cwd: root, title: info.title, reply: info.reply, prompts: info.prompts, lastActivity, resume: `claude --resume ${sessionId}` }] : [];
        });
      });
    },

    /**
     * Has Claude Code fetch the usage limits if they are more than 5 minutes old (an hour for a login without plan
     * limits), or now if `force`. Returns a promise of whether it answered, or undefined when no fetch was needed.
     */
    refreshAccount(force = false) {
      const now = Date.now();
      const every = usage?.answer?.rate_limits_available === false ? USAGE_RETRY_NO_LIMITS_MS : USAGE_REFRESH_MS;
      if (usageFetch || (!force && now - usageTriedAt < every)) return undefined;
      usageTriedAt = now;
      usageFetch = fetchUsage(claudeCommands, (pid) => { usagePid = pid; }).then((answer) => {
        usage = answer ? { answer } : { failed: true };
        return true;
      }).finally(() => {
        usagePid = undefined;
        usageFetch = undefined;
      });
      return usageFetch;
    },

    /**
     * The account (from ~/.claude.json) and the usage limits behind Claude Code's /usage screen (from its latest
     * get_usage answer).
     */
    account() {
      const config = readJson(path.join(home, '.claude.json'));
      const a = config?.oauthAccount && typeof config.oauthAccount === 'object' ? config.oauthAccount : undefined;
      const answer = usage?.answer;
      if (!a && !answer) return undefined;
      const tier = /(\d+x)$/.exec(String(a?.organizationRateLimitTier ?? ''))?.[1];
      const plan = [PLANS[a?.organizationType] ?? SUBSCRIPTIONS[answer?.subscription_type], tier].filter(Boolean).join(' ');
      const who = { name: oneLine(a?.displayName), email: oneLine(a?.emailAddress) };
      // API key, Bedrock and Vertex logins are billed per token: there are no plan limits to show.
      if (answer?.rate_limits_available === false) return { ...who, plan: plan || 'API', limits: [], note: 'No plan limits: usage is billed per token.' };
      if (usage?.failed) return { ...who, plan, limits: [], error: "Couldn't get usage limits from Claude Code." };
      if (!answer) return { ...who, plan, limits: [], note: 'Loading usage…' };
      const limits = usageRows(answer.rate_limits);
      return { ...who, plan, limits, note: limits.length ? undefined : 'No usage limits reported for this plan.' };
    },
  };
}

module.exports = { createClaude, projectDir, usageRows };
