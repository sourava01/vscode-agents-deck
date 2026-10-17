// Renders the panel: Active Agents, Closed Agents, and the Accounts footer. Cards are kept per session and
// re-rendered only when their HTML changes, so the periodic refresh doesn't flicker or steal focus.
(() => {
  const vscode = acquireVsCodeApi();
  const collapsed = vscode.getState()?.collapsed ?? {};
  const STATES = { busy: 'Working', waiting: 'Needs input', completed: 'Completed', idle: 'Idle' };
  const WAITING = { 'input needed': 'Waiting for your answer', 'dialog open': 'A dialog is waiting for you' };
  const CHEVRON = '<svg class="chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.7 13.7 5 13l4.6-4.6L5 3.7 5.7 3l5.3 5.4z" fill="currentColor"/></svg>';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function ago(ms, now) {
    const m = Math.floor((now - ms) / 60000);
    if (m < 1) return `${Math.max(0, Math.round((now - ms) / 1000))}s`;
    if (m < 60) return `${m}m`;
    if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${Math.floor(m / 1440)}d`;
  }

  function until(ms, now) {
    const m = Math.max(0, Math.round((ms - now) / 60000));
    if (m < 1440) return `in ${m >= 60 ? `${Math.floor(m / 60)}h ` : ''}${m % 60}m`;
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  /** A section with a header that collapses it; the collapsed state survives reloads of the panel. */
  function collapsible(tag, key, title, extraHtml = '') {
    const el = document.createElement(tag);
    el.innerHTML = `<button type="button" class="section-head">${CHEVRON}<span class="section-title">${title}</span><span class="count"></span></button>${extraHtml}`;
    const head = el.firstElementChild;
    const set = (value) => {
      collapsed[key] = value;
      el.classList.toggle('collapsed', value);
      head.ariaExpanded = String(!value);
    };
    set(Boolean(collapsed[key]));
    head.addEventListener('click', () => {
      set(!collapsed[key]);
      vscode.setState({ collapsed });
    });
    return el;
  }

  // One line under the title: idle and completed agents show Claude's last reply, working ones the current tool,
  // and ones that need input the permission they are waiting on (or a generic waiting message).
  function body(a) {
    const line = (html, kind = 'activity') => `<div class="body ${kind}">${html}</div>`;
    if (a.status === 'idle' || a.status === 'completed') return a.reply ? line(esc(a.reply), 'output') : '';
    if (a.status === 'busy') return line(a.tool ? `<span class="tool">${esc(a.tool.name)}</span> ${esc(a.tool.detail)}` : '<span class="tool">Thinking…</span>');
    if (a.tool && a.tool.name !== 'AskUserQuestion') return line(`<span class="tool">Allow ${esc(a.tool.name)}?</span> ${esc(a.tool.detail)}`);
    return line(esc((Object.hasOwn(WAITING, a.waitingFor) ? WAITING[a.waitingFor] : a.waitingFor) ?? 'Waiting for your input'));
  }

  const CARDS = {
    active: (a, now) => ({
      cls: `card ${a.status}${a.viewing ? ' viewing' : ''}`,
      label: `${a.title}, ${STATES[a.status]}`,
      html: `<div class="head"><span class="dot"></span><span class="state">${STATES[a.status]}</span>`
        + (a.statusSince ? `<span class="since">· ${ago(a.statusSince, now)}</span>` : '')
        + (a.viewing ? '<span class="pill">Viewing</span>' : a.source === 'background' ? '<span class="pill quiet">Background</span>' : '')
        + `<span class="harness">${esc(a.harnessLabel)}</span>`
        + `</div><div class="title">${esc(a.title)}</div>${body(a)}`,
    }),
    closed: (a, now) => ({
      cls: 'card closed',
      label: `${a.title}, resume`,
      html: `<div class="top"><div class="title">${esc(a.title)}</div>`
        + `<span class="when" title="${esc(new Date(a.lastActivity).toLocaleString())}">${esc(a.harnessLabel)} · ${ago(a.lastActivity, now)} ago</span>`
        + '<span class="resume">Resume ↵</span></div>'
        + (a.reply ? `<div class="body output">${esc(a.reply)}</div>` : ''),
    }),
  };

  const root = document.getElementById('root');
  const sections = {};
  for (const [key, title, empty] of [
    ['active', 'Active Agents', '<strong>No agents running</strong>Start <code>claude</code>, <code>codex</code> or <code>pi</code> in a terminal in this window and it shows up here.'],
    ['closed', 'Closed Agents', '<strong>No closed sessions</strong>Recent agent sessions from this project show up here.'],
  ]) {
    const search = key === 'closed' ? '<input class="search" type="search" placeholder="Search" aria-label="Search closed sessions">' : '';
    const el = collapsible('section', key, title, `${search}<div class="list"></div>`);
    el.classList.add('section');
    root.append(el);
    const more = Object.assign(document.createElement('button'), { type: 'button', className: 'more', textContent: 'Show more' });
    more.addEventListener('click', () => vscode.postMessage({ type: 'more' }));
    sections[key] = {
      key,
      empty,
      list: el.querySelector('.list'),
      count: el.querySelector('.count'),
      search: el.querySelector('.search'),
      emptyEl: Object.assign(document.createElement('div'), { className: 'empty' }),
      more,
      el,
      cards: new Map(), // agent key -> { el, html }
    };
  }

  // Search runs in the extension, so it covers every closed session, not just the loaded page.
  let searchTimer;
  sections.closed.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', query: sections.closed.search.value }), 200);
  });

  function renderSection(section, { agents = [], total = agents.length, hasMore = false }, now) {
    const { key, list, count, cards, search, emptyEl, more } = section;
    count.textContent = total;
    const keys = new Set(agents.map((a) => a.key));
    for (const key of cards.keys()) if (!keys.has(key)) cards.delete(key);

    const nodes = agents.map((a) => {
      let card = cards.get(a.key);
      if (!card) {
        card = { el: Object.assign(document.createElement('button'), { type: 'button' }) };
        card.el.addEventListener('click', () => vscode.postMessage({ type: 'open', section: key, key: a.key }));
        cards.set(a.key, card);
      }
      const { cls, label, html } = CARDS[key](a, now);
      card.el.className = cls;
      card.el.ariaLabel = label;
      if (card.html !== html) card.el.innerHTML = card.html = html;
      return card.el;
    });
    if (!agents.length) {
      const query = search?.value.trim();
      emptyEl.innerHTML = query ? `No closed sessions match <strong>${esc(query)}</strong>` : section.empty;
      nodes.push(emptyEl);
    }
    if (hasMore) nodes.push(more);

    // Re-insert only when the order changed: moving a node drops its focus.
    const current = [...list.children];
    if (current.length !== nodes.length || current.some((node, i) => node !== nodes[i])) list.replaceChildren(...nodes);
  }

  // Subscriptions and their usage limits, pinned to the bottom of the panel.
  const footer = collapsible('footer', 'account', 'Accounts', '<div class="account-body"></div>');
  footer.classList.add('account');
  footer.querySelector('.count').remove();
  document.body.append(footer);
  const accountBody = footer.querySelector('.account-body');

  function renderAccounts(accounts, now) {
    footer.hidden = !accounts?.length;
    if (footer.hidden) return;
    const html = accounts.map((a) => `<div class="account-card"><div class="who"><span class="name">${esc(a.harness)}</span>`
      + (a.plan ? `<span class="plan">${esc(a.plan)}</span>` : '') + '</div>'
      + (a.email || a.name ? `<div class="email">${esc(a.email || a.name)}</div>` : '')
      + a.limits.map((l) => `<div class="limit${l.percent >= 90 ? ' high' : l.percent >= 70 ? ' warn' : ''}">`
        + `<div class="limit-row"><span>${esc(l.label)}</span>`
        + (l.resetsAt ? `<span class="reset">Resets ${until(l.resetsAt, now)}</span>` : '')
        + `<span class="percent">${Math.round(l.percent)}%</span></div>`
        + `<progress class="bar" max="100" value="${l.percent}"></progress></div>`).join('')
      + '</div>').join('');
    if (accountBody.dataset.html !== html) accountBody.innerHTML = accountBody.dataset.html = html;
  }

  window.addEventListener('message', ({ data }) => {
    renderAccounts(data.accounts, data.now);
    renderSection(sections.active, { agents: data.active }, data.now);
    sections.closed.el.hidden = !data.closed; // turned off in settings
    if (data.closed) renderSection(sections.closed, data.closed, data.now);
  });
  vscode.postMessage({ type: 'ready' });
})();
