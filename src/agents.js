// Agent logic that doesn't need VS Code: ordering, search, chat-tab matching and the Completed marker.

/** Whether a chat tab belongs to a session: Claude Code titles tabs with the session title, cut to 24 characters plus "…". */
function chatTabMatches(label, title) {
  if (!label) return false;
  return label.endsWith('…') ? title.startsWith(label.slice(0, -1)) : label === title;
}

const RANK = { waiting: 0, completed: 1, busy: 2, idle: 3 };
// By status, then the one whose status changed most recently first (the time shown on its card).
const byStatus = (a, b) => RANK[a.status] - RANK[b.status] || (b.statusSince ?? 0) - (a.statusSince ?? 0);

/** Closed sessions whose title or last reply contains `query` (case-insensitive), in the same order. */
function searchClosed(sessions, query) {
  const q = query.trim().toLowerCase();
  return q ? sessions.filter((s) => `${s.title} ${s.reply}`.toLowerCase().includes(q)) : sessions;
}

/**
 * Marks agents that went idle since the previous call as "completed", until you view them. An agent missing from a
 * call is forgotten, so one resumed later starts afresh.
 * ponytail: a whole turn that starts and ends between two calls isn't caught.
 */
class CompletionTracker {
  #lastStatus = new Map(); // agent key -> status at the previous call
  #completed = new Set();

  apply(agents) {
    const lastStatus = this.#lastStatus;
    this.#lastStatus = new Map(agents.map((a) => [a.key, a.status]));
    for (const key of this.#completed) if (!this.#lastStatus.has(key)) this.#completed.delete(key);
    return agents.map((agent) => {
      const { key, status, viewing } = agent;
      if (viewing || status !== 'idle') this.#completed.delete(key);
      else if ((lastStatus.get(key) ?? 'idle') !== 'idle') this.#completed.add(key);
      return this.#completed.has(key) ? { ...agent, status: 'completed' } : agent;
    });
  }
}

/**
 * Remembers the sessions that moved between Active and Closed Agents in the last `markMs`, so the panel can mark
 * them: one that stopped running ("Just closed") and a closed one that runs again ("Resumed").
 */
class MoveTracker {
  #active = new Set(); // agent keys in Active Agents at the previous call
  #moved = new Map(); // agent key -> { to: 'active' | 'closed', at }

  constructor(markMs) {
    this.markMs = markMs;
  }

  /** Records the keys now in Active and Closed Agents. Returns whether an agent joined or left Active since the last call. */
  update(activeKeys, closedKeys, now) {
    let changed = false;
    for (const key of this.#active) {
      if (activeKeys.has(key)) continue;
      this.#moved.set(key, { to: 'closed', at: now });
      changed = true;
    }
    for (const key of activeKeys) {
      if (this.#active.has(key)) continue;
      if (closedKeys.has(key)) this.#moved.set(key, { to: 'active', at: now });
      else this.#moved.delete(key); // a new session, or one that was hidden only briefly
      changed = true;
    }
    for (const [key, { at }] of this.#moved) if (now - at >= this.markMs) this.#moved.delete(key);
    this.#active = activeKeys;
    return changed;
  }

  /** Whether the session moved to `to` ('active' or 'closed') recently. */
  moved(key, to) {
    return this.#moved.get(key)?.to === to;
  }
}

module.exports = { chatTabMatches, byStatus, searchClosed, CompletionTracker, MoveTracker };
