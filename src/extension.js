// Agents Deck: a sidebar panel listing the coding agents (Claude Code, Codex, pi) running in this window, the project's
// recent sessions, and your subscriptions' usage limits.
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { parseProcessTable, parseCwds, findOwner } = require('./processes');
const { chatTabMatches, byStatus, searchClosed, CompletionTracker, MoveTracker } = require('./agents');
const { readConfig } = require('./config');
const { within } = require('./util');
const { createClaude } = require('./harnesses/claude');
const { createCodex } = require('./harnesses/codex');
const { createPi } = require('./harnesses/pi');

const PAGE_SIZE = 25;
const CLOSED_REFRESH_MS = 30000;
const MIN_PROMPTS = 3; // closed sessions with fewer messages from you are hidden, unless turned off in settings
const MOVED_MARK_MS = 10 * 60 * 1000; // how long a session that just closed or resumed is marked
const DAY_MS = 24 * 60 * 60 * 1000;

const home = os.homedir();
const HARNESSES = [createClaude({ home }), createCodex({ home }), createPi({ home })];

// lsof exits non-zero when one of the listed processes has exited meanwhile, but still prints the others.
const run = (cmd, args) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout, (err) => err.stdout ?? '');
// VS Code resolves a terminal's process ID only once its process has connected, which can take a while for
// terminals restored after a reload. A terminal that isn't ready is skipped and picked up on a later refresh.
const terminalPid = (terminal) => within(terminal.processId, 500, undefined);
const roots = () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
const inWorkspace = (dir) => roots().some((root) => dir === root || dir.startsWith(root + path.sep));

/** Every enabled harness's running sessions, tagged with the harness. Shared by Active and Closed Agents. */
async function liveSessions(harnesses) {
  const table = parseProcessTable(await run('ps', ['-axo', 'pid=,ppid=,lstart=,args=']));
  // Harnesses without a session registry are matched by working directory, so look those up (one lsof call).
  const pids = [...table].filter(([, proc]) => harnesses.some((h) => h.wantsCwd(proc))).map(([pid]) => pid);
  const cwds = pids.length ? parseCwds(await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'])) : new Map();
  return {
    table,
    sessions: harnesses.flatMap((h) => h.live({ table, cwds }).map((s) => ({
      ...s,
      harness: h.id,
      harnessLabel: h.label,
      key: `${h.id}:${s.sessionId ?? `pid${s.pid}`}`,
    }))),
  };
}

class AgentsView {
  #completion = new CompletionTracker();
  #moves = new MoveTracker(MOVED_MARK_MS);
  #attachTerminals = new Map(); // agent key -> terminal opened with `claude attach`
  #windowKeys = new Set(); // agents shown in this window so far, whose forks belong here too
  #active = new Map(); // agent key -> agent, for clicks
  #closed = [];
  #closedAt = 0;
  #limit = PAGE_SIZE;
  #query = '';
  #refreshing = Promise.resolve(); // refreshes run one at a time

  constructor(extensionUri, getConfig) {
    this.extensionUri = extensionUri;
    this.getConfig = getConfig;
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const uri = (file) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file));
    const nonce = crypto.randomBytes(16).toString('base64');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('view.css')}"></head>
<body><main id="root"></main><script nonce="${nonce}" src="${uri('view.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage((msg) => this.#onMessage(msg));
    view.onDidChangeVisibility(() => this.refresh(true));
  }

  /**
   * Re-reads active agents; closed sessions only every 30 seconds, unless `includeClosed` or an agent started or
   * stopped; and usage limits only every 5 minutes, unless `refetchUsage`.
   */
  refresh(includeClosed = false, refetchUsage = false) {
    this.#refreshing = this.#refreshing.then(() => this.#refresh(includeClosed, refetchUsage)).catch(() => {});
    return this.#refreshing;
  }

  async #refresh(includeClosed, refetchUsage) {
    if (!this.view?.visible) return;
    const config = this.getConfig();
    const harnesses = HARNESSES.filter((h) => config.harnesses[h.id]);
    // Harnesses that refresh their limits on request (Claude) show the new numbers once they have them.
    if (config.accounts) for (const h of harnesses) h.refreshAccount?.(refetchUsage)?.then(() => this.refresh());
    const { table, sessions } = await liveSessions(harnesses);

    const active = this.#completion.apply(await this.#activeAgents(table, sessions, config.sources));
    active.sort(byStatus);
    this.#active = new Map(active.map((agent) => [agent.key, agent]));
    // An agent that left Active belongs in Closed Agents now (and a resumed one no longer does), so re-read those too.
    const moved = this.#moves.update(new Set(this.#active.keys()), new Set(this.#closed.map((s) => s.key)), Date.now());

    if (config.closedMaxAgeDays === 0) this.#closed = [];
    else if (includeClosed || moved || Date.now() - this.#closedAt > CLOSED_REFRESH_MS) {
      const live = new Set(sessions.map((s) => s.sessionId).filter(Boolean));
      const since = Date.now() - config.closedMaxAgeDays * DAY_MS;
      this.#closed = searchClosed(harnesses.flatMap((h) => h.closed({ roots: roots(), since, live })
        .filter((s) => !config.closedHideShort || !(s.prompts < MIN_PROMPTS))
        .map((s) => ({ ...s, harness: h.id, harnessLabel: h.label, key: `${h.id}:${s.sessionId}` }))), this.#query);
      this.#closedAt = Date.now();
    }

    // Sessions that just closed go first, so they're easy to find even if their last message was long ago.
    const justClosed = (s) => this.#moves.moved(s.key, 'closed');
    const closed = [...this.#closed.filter(justClosed), ...this.#closed.filter((s) => !justClosed(s))];
    this.view.webview.postMessage({
      now: Date.now(),
      active: active.map(({ terminal, ...agent }) => ({ ...agent, resumed: this.#moves.moved(agent.key, 'active') })),
      closed: config.closedMaxAgeDays === 0 ? undefined : {
        agents: closed.slice(0, this.#limit).map(({ resume, ...s }) => ({ ...s, justClosed: justClosed(s) })),
        total: closed.length,
        hasMore: closed.length > this.#limit,
      },
      accounts: config.accounts ? harnesses.flatMap((h) => {
        const account = h.account();
        return account ? [{ harness: h.label, ...account }] : [];
      }) : undefined,
    });
  }

  /**
   * The sessions that belong to this window: in one of its terminals, its chat panels, or background sessions of its
   * folders or forked from one of its agents (which stay once shown, even after that agent exits).
   */
  async #activeAgents(table, sessions, sources) {
    const terminals = vscode.window.terminals;
    const pids = await Promise.all(terminals.map(terminalPid));
    const terminalByPid = new Map(pids.map((pid, i) => [pid, terminals[i]]));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const viewedTerminal = tab?.input instanceof vscode.TabInputTerminal ? vscode.window.activeTerminal : undefined;
    const chatLabel = tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('claudeVSCodePanel') ? tab.label : undefined;

    // Background sessions last, so the agents they may be forked from are known by then.
    const ordered = [...sessions.filter((s) => !s.background), ...sessions.filter((s) => s.background)];
    return ordered.flatMap((session) => {
      // A terminal's shell among the agent's ancestors means it runs in that terminal; this extension host means it
      // runs in an extension's chat panel in this window (the chat starts it as a child process). Not for background
      // sessions: they run under Claude Code's daemon, which descends from whichever terminal's `claude` started it.
      const owner = session.background ? undefined : findOwner(session.pid, table, (pid) => terminalByPid.has(pid) || pid === process.pid);
      let source;
      let terminal = terminalByPid.get(owner);
      if (terminal) source = 'terminal';
      else if (owner === process.pid) source = 'extension';
      else if (session.background && (inWorkspace(session.cwd) || this.#windowKeys.has(session.key)
        || (session.forkedFrom && this.#windowKeys.has(`${session.harness}:${session.forkedFrom}`)))) {
        source = 'background';
        terminal = this.#attachTerminals.get(session.key);
        if (terminal && !terminals.includes(terminal)) terminal = undefined; // closed since
      }
      if (!source || !sources[source]) return [];
      this.#windowKeys.add(session.key);
      const viewing = terminal ? terminal === viewedTerminal : source === 'extension' && session.chatTab && chatTabMatches(chatLabel, session.title);
      return [{ ...session, source, terminal, viewing }];
    });
  }

  #onMessage(msg) {
    switch (msg?.type) {
      case 'ready':
        return this.refresh(true);
      case 'more':
        this.#limit += PAGE_SIZE;
        return this.refresh(true);
      case 'search':
        this.#query = String(msg.query ?? '');
        this.#limit = PAGE_SIZE;
        return this.refresh(true);
      case 'open':
        return msg.section === 'active' ? this.#openActive(this.#active.get(msg.key)) : this.#resume(this.#closed.find((s) => s.key === msg.key));
    }
  }

  #openActive(agent) {
    if (!agent) return;
    if (agent.terminal) agent.terminal.show(false);
    else if (agent.attach) {
      const terminal = this.#newTerminal(agent.title, agent.cwd, agent.attach);
      this.#attachTerminals.set(agent.key, terminal);
    } else if (agent.chatTab) {
      vscode.commands.executeCommand('claude-vscode.editor.open', agent.sessionId);
    }
  }

  #resume(session) {
    if (session) this.#newTerminal(session.title, session.cwd, session.resume);
  }

  // Commands come only from the harness adapters, which build them from validated session IDs.
  #newTerminal(title, cwd, command) {
    const terminal = vscode.window.createTerminal({ name: title.slice(0, 40), cwd, location: vscode.TerminalLocation.Editor });
    terminal.show(false);
    terminal.sendText(command);
    return terminal;
  }
}

function activate(context) {
  const getConfig = () => readConfig((key) => vscode.workspace.getConfiguration('agentsDeck').get(key));
  const view = new AgentsView(context.extensionUri, getConfig);
  let timer;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => view.refresh(), 250);
  };
  let poll;
  const startPolling = () => {
    clearInterval(poll);
    poll = setInterval(() => view.refresh(), getConfig().refreshMs);
  };
  startPolling();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentsDeck.main', view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('agentsDeck.refresh', () => view.refresh(true, true)), // the title bar's refresh button
    vscode.window.onDidChangeWindowState(refreshSoon),
    vscode.window.onDidChangeActiveTerminal(refreshSoon),
    vscode.window.onDidOpenTerminal(refreshSoon),
    vscode.window.onDidCloseTerminal(refreshSoon),
    vscode.window.tabGroups.onDidChangeTabs(refreshSoon),
    vscode.workspace.onDidChangeWorkspaceFolders(() => view.refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('agentsDeck')) return;
      startPolling();
      view.refresh(true);
    }),
    { dispose: () => { clearInterval(poll); clearTimeout(timer); } },
  );
}

module.exports = { activate };
