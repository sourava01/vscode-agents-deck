// OpenAI Codex CLI. It keeps no registry of running sessions: a running `codex` process is matched to the rollout
// transcript it writes in ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl (created when it starts),
// by working directory and start time. Titles come from ~/.codex/session_index.jsonl; the account from the ID
// token in ~/.codex/auth.json; usage limits from the rate limits Codex records in each turn.
const path = require('path');
const { UUID, parseJson, readJson, readDir, mtimeOf, oneLine, timeOf, toolDetail, firstLine, JsonlFollower } = require('../util');

const DAY_MS = 24 * 60 * 60 * 1000;
const START_SLACK_MS = 5000; // `ps` start times are rounded to the second
const WAITING = {
  exec_approval_request: 'Approve command',
  apply_patch_approval_request: 'Approve file changes',
  request_user_input: 'Waiting for your answer',
  elicitation_request: 'Waiting for your answer',
};
const RELEVANT = /"type":"(event_msg|response_item)"/;

/** Text of a message's content blocks of the given type ("input_text" for prompts, "output_text" for replies). */
const textOf = (content, type) => (Array.isArray(content) ? content.filter((b) => b?.type === type).map((b) => b.text).join(' ') : '');

function toolOf(item) {
  if (item.type === 'function_call') return { name: String(item.name), detail: toolDetail(parseJson(item.arguments)) };
  if (item.type === 'custom_tool_call') return { name: String(item.name), detail: oneLine(String(item.input ?? '').split('\n')[0]).slice(0, 160) };
  if (item.type === 'local_shell_call') return { name: 'shell', detail: toolDetail(item.action) };
  return undefined;
}

/** Folds one rollout line into the transcript state: status, latest tool, latest reply, rate limits. */
function scan(line, state) {
  if (!RELEVANT.test(line)) return;
  const record = parseJson(line);
  const p = record?.payload;
  if (!p || typeof p !== 'object') return;
  state.seq++;
  const at = timeOf(record.timestamp);

  if (record.type === 'event_msg') {
    if (p.type === 'token_count') {
      if (p.rate_limits) state.rateLimits = p.rate_limits;
      return;
    }
    if (p.type === 'user_message') {
      Object.assign(state, { promptSeq: state.seq, promptAt: at });
      state.firstPrompt ??= oneLine(p.message).slice(0, 80);
    } else if (p.type === 'agent_message') {
      state.reply = oneLine(p.message).slice(0, 300);
    }
    if (Object.hasOwn(WAITING, p.type)) Object.assign(state, { status: 'waiting', waitingFor: WAITING[p.type], statusAt: at });
    else if (p.type === 'task_complete' || p.type === 'turn_aborted') Object.assign(state, { status: 'idle', statusAt: at });
    else if (p.type === 'task_started' || state.status === 'waiting') Object.assign(state, { status: 'busy', statusAt: at });
    return;
  }

  // Codex records your prompts and its replies as messages. Text it adds itself (environment, instructions) comes
  // as XML-tagged blocks, which are not prompts.
  if (p.type === 'message' && p.role === 'user') {
    const text = textOf(p.content, 'input_text').trim();
    if (text && !text.startsWith('<')) {
      Object.assign(state, { promptSeq: state.seq, promptAt: timeOf(record.timestamp) });
      state.firstPrompt ??= oneLine(text).slice(0, 80);
    }
  } else if (p.type === 'message' && p.role === 'assistant') {
    const text = textOf(p.content, 'output_text');
    if (text.trim()) state.reply = oneLine(text).slice(0, 300);
  }
  const tool = toolOf(p);
  if (tool) state.tool = { ...tool, seq: state.seq };
  if (state.status === 'waiting') Object.assign(state, { status: 'busy', statusAt: at });
}

const summarize = (s) => ({
  used: s.firstPrompt !== undefined,
  promptAt: s.promptAt,
  firstPrompt: s.firstPrompt,
  status: s.status ?? 'idle',
  waitingFor: s.status === 'waiting' ? s.waitingFor : undefined,
  statusAt: s.statusAt,
  // A tool call from before your latest prompt belongs to an earlier turn.
  tool: s.tool && !(s.promptSeq > s.tool.seq) ? { name: s.tool.name, detail: s.tool.detail } : undefined,
  reply: s.reply ?? '',
  rateLimits: s.rateLimits,
});

/** Decodes the claims of a JWT without verifying it; only display fields are read from them. */
function jwtClaims(token) {
  const payload = typeof token === 'string' ? token.split('.')[1] : undefined;
  return payload ? parseJson(Buffer.from(payload, 'base64url').toString('utf8')) : undefined;
}

function limitLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'Limit';
  if (minutes === 7 * 24 * 60) return 'Weekly';
  return minutes < 24 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / (24 * 60))}d`;
}

// Codex's plan types (PlanType in codex-rs/protocol/src/account.rs); others are shown title-cased.
const PLANS = {
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  ent26: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  edu_plus: 'Edu',
};
const planLabel = (plan) => PLANS[plan] ?? oneLine(String(plan ?? '')).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Why Codex stopped answering, from the rate limits it records (RateLimitReachedType).
const REACHED = {
  rate_limit_reached: 'Usage limit reached.',
  workspace_owner_credits_depleted: 'Workspace credits used up.',
  workspace_member_credits_depleted: 'Workspace credits used up. Ask your workspace owner for more.',
  workspace_owner_usage_limit_reached: 'Workspace usage limit reached.',
  workspace_member_usage_limit_reached: 'Workspace usage limit reached. Ask your workspace owner to raise it.',
};

/**
 * The rows and note for Codex's latest rate limits: its time windows, a personal spend limit, and otherwise how
 * credits cover usage (business and enterprise plans often have no time windows).
 */
function codexUsage(r) {
  const limits = [r?.primary, r?.secondary]
    .filter((l) => Number.isFinite(l?.used_percent))
    .map((l) => ({ label: limitLabel(l.window_minutes), percent: l.used_percent, resetsAt: Number.isFinite(l.resets_at) ? l.resets_at * 1000 : undefined }));
  const spend = r?.individual_limit;
  if (Number.isFinite(spend?.remaining_percent)) {
    limits.push({
      label: 'Spend limit',
      percent: 100 - spend.remaining_percent,
      detail: `${oneLine(String(spend.used))} of ${oneLine(String(spend.limit))}`,
      resetsAt: Number.isFinite(spend.resets_at) ? spend.resets_at * 1000 : undefined,
    });
  }
  const credits = r?.credits;
  const note = REACHED[r?.rate_limit_reached_type]
    ?? (r?.spend_control_reached === true ? 'Spend limit reached.' : undefined)
    ?? (limits.length || !credits ? undefined
      : credits.unlimited ? 'Unlimited credits.'
        : credits.balance ? `Credits: ${oneLine(String(credits.balance))}`
          : credits.has_credits ? 'No usage limits: usage is paid with credits.' : 'No credits left.');
  return { limits, note };
}

// The interactive CLI, not its background app-server.
const isCli = (proc) => proc.command === 'codex' && !proc.args.includes('app-server');

function createCodex({ home }) {
  const root = path.join(home, '.codex');
  const sessionsDir = path.join(root, 'sessions');
  const transcripts = new JsonlFollower({ initialState: () => ({ seq: 0 }), scan, summarize });
  const metas = new Map(); // file -> session_meta payload; the first line never changes

  function meta(file) {
    if (!metas.has(file)) {
      const record = parseJson(firstLine(file));
      const p = record?.type === 'session_meta' ? record.payload : undefined;
      metas.set(file, p && UUID.test(p.id) && typeof p.cwd === 'string'
        ? { id: p.id, cwd: p.cwd, startedAt: timeOf(p.timestamp) ?? 0, subagent: Boolean(p.source?.subagent) || p.thread_source === 'subagent' }
        : undefined);
    }
    return metas.get(file);
  }

  /** Rollouts in the day folders from `since` to today, newest first. Subagent threads are left out. */
  function rollouts(since) {
    const files = [];
    for (let t = Date.now(); t >= since - DAY_MS; t -= DAY_MS) {
      const d = new Date(t);
      const dir = path.join(sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      for (const name of readDir(dir)) {
        const file = path.join(dir, name);
        const m = name.endsWith('.jsonl') ? meta(file) : undefined;
        const mtime = m && !m.subagent ? mtimeOf(file) : undefined;
        if (mtime >= since) files.push({ file, mtime, ...m });
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime);
  }

  const titles = new JsonlFollower({
    initialState: () => new Map(),
    scan(line, names) {
      const entry = parseJson(line);
      if (UUID.test(entry?.id) && entry.thread_name) names.set(entry.id, oneLine(entry.thread_name));
    },
    summarize: (names) => names,
  });
  const titleOf = (id, info) => titles.read(path.join(root, 'session_index.jsonl'))?.get(id) || info.firstPrompt || 'New session';

  return {
    id: 'codex',
    label: 'Codex',
    wantsCwd: isCli,

    live({ table, cwds }) {
      const procs = [...table].filter(([pid, proc]) => isCli(proc) && cwds.has(pid)).sort((a, b) => b[1].startedAt - a[1].startedAt);
      if (!procs.length) return [];
      const candidates = rollouts(Math.min(...procs.map(([, proc]) => proc.startedAt)) - START_SLACK_MS);
      const claimed = new Set();
      return procs.map(([pid, proc]) => {
        const cwd = cwds.get(pid);
        // The newest rollout from this folder since the process started (a /new inside Codex starts another one).
        const rollout = candidates.find((r) => !claimed.has(r.file) && r.cwd === cwd && r.startedAt >= proc.startedAt - START_SLACK_MS);
        if (rollout) claimed.add(rollout.file);
        const info = rollout ? transcripts.read(rollout.file) ?? summarize({}) : summarize({});
        return {
          sessionId: rollout?.id,
          pid,
          cwd,
          title: rollout ? titleOf(rollout.id, info) : 'New session',
          status: info.status,
          waitingFor: info.waitingFor,
          statusSince: info.statusAt ?? proc.startedAt,
          startedAt: proc.startedAt,
          lastInputAt: info.promptAt ?? proc.startedAt,
          tool: info.tool,
          reply: info.reply,
        };
      });
    },

    closed({ roots, since, live }) {
      return rollouts(since).flatMap((r) => {
        if (live.has(r.id) || !roots.includes(r.cwd)) return [];
        const info = transcripts.read(r.file);
        return info?.used ? [{ sessionId: r.id, cwd: r.cwd, title: titleOf(r.id, info), reply: info.reply, lastActivity: r.mtime, resume: `codex resume ${r.id}` }] : [];
      });
    },

    /** The ChatGPT account from the ID token (never the access or refresh token) and the latest rate limits. */
    account() {
      const auth = readJson(path.join(root, 'auth.json'));
      const claims = jwtClaims(auth?.tokens?.id_token);
      if (!claims) {
        // Signed in with an OpenAI API key: billed per token, no plan limits.
        return auth?.OPENAI_API_KEY || auth?.auth_mode === 'apikey'
          ? { name: '', email: '', plan: 'API key', limits: [], note: 'No plan limits: usage is billed per token.' }
          : undefined;
      }
      const latest = rollouts(Date.now() - 7 * DAY_MS)[0];
      const rateLimits = latest ? transcripts.read(latest.file)?.rateLimits : undefined;
      // The plan Codex last reported beats the one in the ID token, which is only as new as the last sign-in.
      const plan = rateLimits?.plan_type ?? claims['https://api.openai.com/auth']?.chatgpt_plan_type;
      return { name: oneLine(claims.name), email: oneLine(claims.email), plan: plan ? planLabel(plan) : '', ...codexUsage(rateLimits) };
    },
  };
}

module.exports = { createCodex, jwtClaims, limitLabel, planLabel, codexUsage };
