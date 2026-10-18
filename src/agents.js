// Agent logic that doesn't need VS Code: ordering, search, chat-tab matching and the Completed marker.

/** Whether a chat tab belongs to a session: Claude Code titles tabs with the session title, cut to 24 characters plus "…". */
function chatTabMatches(label, title) {
  if (!label) return false;
  return label.endsWith('…') ? title.startsWith(label.slice(0, -1)) : label === title;
}

const RANK = { waiting: 0, completed: 1, busy: 2, idle: 3 };
// By status, then the agent you last sent a message to first (one you haven't messaged counts from its start).
const byStatus = (a, b) => RANK[a.status] - RANK[b.status] || b.lastInputAt - a.lastInputAt;

/** Closed sessions whose title or last reply contains `query` (case-insensitive), newest first. */
function searchClosed(sessions, query) {
  const q = query.trim().toLowerCase();
  return sessions
    .filter((s) => `${s.title} ${s.reply}`.toLowerCase().includes(q))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Marks agents that went idle since the previous call as "completed", until you view them.
 * ponytail: a whole turn that starts and ends between two calls isn't caught.
 */
class CompletionTracker {
  #lastStatus = new Map(); // agent key -> status at the previous call
  #completed = new Set();

  apply(agents) {
    return agents.map((agent) => {
      const { key, status, viewing } = agent;
      if (viewing || status !== 'idle') this.#completed.delete(key);
      else if ((this.#lastStatus.get(key) ?? 'idle') !== 'idle') this.#completed.add(key);
      this.#lastStatus.set(key, status);
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
