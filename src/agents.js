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

module.exports = { chatTabMatches, byStatus, searchClosed, CompletionTracker };
