// pi (pi-coding-agent). It keeps no registry of running sessions: a running `pi` process is matched to the newest
// session file in ~/.pi/agent/sessions/--<cwd>--/ (created on the first prompt). pi uses your own provider keys,
// so it has no subscription to show, and it records no permission prompts, so "needs input" can't be detected.
const path = require('path');
const { UUID, parseJson, readDir, mtimeOf, oneLine, timeOf, plainText, toolDetail, JsonlFollower } = require('../util');

const START_SLACK_MS = 5000; // `ps` start times are rounded to the second

// pi's own folder naming: drop the leading slash, then "/", "\" and ":" become "-" (dots are kept).
const sessionDir = (home, cwd) => path.join(home, '.pi', 'agent', 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '');

/** Folds one session line into the state: id, name, status, latest tool and reply. */
function scan(line, state) {
  const entry = parseJson(line);
  if (!entry || typeof entry !== 'object') return;
  state.seq++;
  if (entry.type === 'session') state.id = entry.id;
  else if (entry.type === 'session_info') state.name = oneLine(entry.name);
  if (entry.type !== 'message' || !entry.message) return;

  const { role, content, stopReason } = entry.message;
  const at = timeOf(entry.timestamp);
  if (role === 'user') {
    state.prompts = (state.prompts ?? 0) + 1;
    Object.assign(state, { promptSeq: state.seq, promptAt: at });
    state.firstPrompt ??= oneLine(textOf(content)).slice(0, 80);
    Object.assign(state, { status: 'busy', statusAt: at });
  } else if (role === 'toolResult') {
    Object.assign(state, { status: 'busy', statusAt: at });
  } else if (role === 'assistant') {
    const blocks = Array.isArray(content) ? content : [];
    const call = blocks.findLast((b) => b?.type === 'toolCall');
    if (call) state.tool = { name: String(call.name), detail: toolDetail(call.arguments), seq: state.seq };
    const text = textOf(content);
    if (text.trim()) state.reply = plainText(text).slice(0, 300);
    // A reply with no tool call ends the turn, however it stopped (done, error, aborted).
    Object.assign(state, { status: call && stopReason !== 'aborted' ? 'busy' : 'idle', statusAt: at });
  }
}

const summarize = (s) => ({
  id: UUID.test(s.id) ? s.id : undefined,
  used: s.firstPrompt !== undefined || Boolean(s.name),
  promptAt: s.promptAt,
  prompts: s.prompts ?? 0, // how many messages you sent
  title: s.name || s.firstPrompt || '',
  status: s.status ?? 'idle',
  statusAt: s.statusAt,
  tool: s.tool && !(s.promptSeq > s.tool.seq) ? { name: s.tool.name, detail: s.tool.detail } : undefined,
  reply: s.reply ?? '',
});

function createPi({ home }) {
  const transcripts = new JsonlFollower({ initialState: () => ({ seq: 0 }), scan, summarize });

  /** Session files of a folder with their last-modified times, newest first. */
  const sessionFiles = (cwd) => {
    const dir = sessionDir(home, cwd);
    return readDir(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ file: path.join(dir, name), mtime: mtimeOf(path.join(dir, name)) ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime);
  };

  return {
    id: 'pi',
    label: 'pi',
    wantsCwd: (proc) => proc.command === 'pi',

    live({ table, cwds }) {
      const claimed = new Set();
      return [...table]
        .filter(([pid, proc]) => proc.command === 'pi' && cwds.has(pid))
        .sort((a, b) => b[1].startedAt - a[1].startedAt)
        .map(([pid, proc]) => {
          const cwd = cwds.get(pid);
          const session = sessionFiles(cwd).find((f) => !claimed.has(f.file) && f.mtime >= proc.startedAt - START_SLACK_MS);
          if (session) claimed.add(session.file);
          const info = (session && transcripts.read(session.file)) || summarize({});
          return {
            sessionId: info.id,
            pid,
            cwd,
            title: info.title || 'New session',
            status: info.status,
            statusSince: info.statusAt ?? proc.startedAt,
            startedAt: proc.startedAt,
            lastInputAt: info.promptAt ?? proc.startedAt,
            tool: info.tool,
            reply: info.reply,
          };
        });
    },

    closed({ roots, since, live }) {
      return roots.flatMap((cwd) => sessionFiles(cwd).flatMap(({ file, mtime }) => {
        if (mtime < since) return [];
        const info = transcripts.read(file);
        if (!info?.used || !info.id || live.has(info.id)) return [];
        return [{ sessionId: info.id, cwd, title: info.title, reply: info.reply, prompts: info.prompts, lastActivity: mtime, resume: `pi --session ${info.id}` }];
      }));
    },

    account: () => undefined,
  };
}

module.exports = { createPi, sessionDir };
