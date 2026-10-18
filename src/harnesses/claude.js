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

function summarize({ found: { customTitle, aiTitle, prompt, tool, reply }, sessionIds }) {
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
 * whether Claude Code answered.
 */
function fetchUsage(commands, onStart) {
  const [command, ...fallbacks] = commands;
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, USAGE_ARGS, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), USAGE_TIMEOUT_MS);
    let answered = false;
    let rest = '';
    child.on('spawn', () => onStart(child.pid));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(err.code === 'ENOENT' ? fetchUsage(fallbacks, onStart) : false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(answered);
    });
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      const response = lines.map(parseJson).find((m) => m?.type === 'control_response' && m.response?.request_id === 'usage')?.response;
      if (!response) return;
      answered = response.subtype === 'success';
      child.stdin.end(); // nothing else to ask, so it exits
    });
    child.stdin.on('error', () => {});
    child.stdin.write(USAGE_REQUEST);
  });
}

const PLANS = { claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise' };

function createClaude({ home, claudeCommands = ['claude', path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'] }) {
  let usagePid; // the `claude` process fetching usage, which registers itself as a session while it runs
  let usageFetch;
  let usageTriedAt = 0;

  const transcripts = new JsonlFollower({
    initialState: () => ({ seq: 0, found: {}, sessionIds: new Set() }),
    scan(line, state) {
      state.seq++;
      const id = sessionIdOf(line);
      if (id) state.sessionIds.add(id);
      for (const [kind, matches] of Object.entries(LINE_KINDS)) {
        if (matches(line)) state.found[kind] = { line, seq: state.seq };
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
          return info.used ? [{ sessionId, cwd: root, title: info.title, reply: info.reply, lastActivity, resume: `claude --resume ${sessionId}` }] : [];
        });
      });
    },

    /**
     * Has Claude Code fetch the usage limits if they are more than 5 minutes old, or now if `force`. Returns a promise
     * of whether it answered, or undefined when no fetch was needed.
     */
    refreshAccount(force = false) {
      const config = readJson(path.join(home, '.claude.json'));
      const fetchedAt = config?.cachedUsageUtilization?.fetchedAtMs;
      const now = Date.now();
      if (!config?.oauthAccount || usageFetch || (!force && now - Math.max(Number.isFinite(fetchedAt) ? fetchedAt : 0, usageTriedAt) < USAGE_REFRESH_MS)) return undefined;
      usageTriedAt = now;
      usageFetch = fetchUsage(claudeCommands, (pid) => { usagePid = pid; }).finally(() => {
        usagePid = undefined;
        usageFetch = undefined;
      });
      return usageFetch;
    },

    /** The account and the usage limits behind Claude Code's /usage screen. */
    account() {
      const config = readJson(path.join(home, '.claude.json'));
      const a = config?.oauthAccount;
      if (!a || typeof a !== 'object') return undefined;
      const tier = /(\d+x)$/.exec(String(a.organizationRateLimitTier ?? ''))?.[1];
      const usage = config.cachedUsageUtilization;
      const limits = usage?.utilization?.limits;
      const label = (l) => (l.kind === 'session' ? 'Session'
        : `Weekly${l.scope ? ` · ${l.scope.model?.display_name ?? l.scope.surface?.display_name ?? 'scoped'}` : ''}`);
      return {
        name: oneLine(a.displayName),
        email: oneLine(a.emailAddress),
        plan: [PLANS[a.organizationType], tier].filter(Boolean).join(' '),
        updatedAt: Number.isFinite(usage?.fetchedAtMs) ? usage.fetchedAtMs : undefined, // when Claude Code last fetched the limits
        limits: (Array.isArray(limits) ? limits : [])
          .filter((l) => Number.isFinite(l?.percent))
          .map((l) => ({ label: label(l), percent: l.percent, resetsAt: Date.parse(l.resets_at) || undefined })),
      };
    },
  };
}

module.exports = { createClaude, projectDir };
