// The extension's settings (contributed as "agentsDeck.*" in package.json), read and validated in one place.

const HARNESSES = ['claude', 'codex', 'pi'];
const SOURCES = ['terminal', 'extension', 'background'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);

/** Reads the settings through `get(key)` (a VS Code configuration lookup) and fills in defaults for bad values. */
function readConfig(get) {
  return {
    harnesses: Object.fromEntries(HARNESSES.map((id) => [id, bool(get(`harnesses.${id}`), true)])),
    sources: Object.fromEntries(SOURCES.map((id) => [id, bool(get(`sources.${id}`), true)])),
    closedMaxAgeDays: clamp(get('closedSessions.maxAgeDays'), 0, 365, 7), // 0 hides Closed Agents
    closedHideShort: bool(get('closedSessions.hideShort'), true),
    accounts: bool(get('accounts.enabled'), true),
    refreshMs: clamp(get('refreshSeconds'), 2, 60, 10) * 1000,
  };
}

module.exports = { readConfig };
