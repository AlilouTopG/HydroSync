'use strict';

const crypto = require('node:crypto');

const MAX_SESSIONS = 1000;
const MAX_TURNS_PER_SESSION = 12;
const SESSION_TTL_MS = 30 * 60 * 1000;

function createConversationStore({
  maxSessions = MAX_SESSIONS,
  maxTurns = MAX_TURNS_PER_SESSION,
  ttlMs = SESSION_TTL_MS,
  now = Date.now
} = {}) {
  const sessions = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, session] of sessions) {
      if (session.lastActiveAt <= cutoff) sessions.delete(id);
    }
  }

  function create() {
    prune();
    while (sessions.size >= maxSessions) {
      sessions.delete(sessions.keys().next().value);
    }
    const id = crypto.randomUUID();
    sessions.set(id, { history: [], lastActiveAt: now() });
    return id;
  }

  function getHistory(id) {
    prune();
    const session = sessions.get(id);
    if (!session) return null;
    session.lastActiveAt = now();
    // Refresh insertion order to make session-cap eviction least-recently used.
    sessions.delete(id);
    sessions.set(id, session);
    return session.history.map(turn => ({ ...turn }));
  }

  function append(id, userMessage, assistantReply) {
    prune();
    const session = sessions.get(id);
    if (!session) return false;
    session.history.push({ user: userMessage, assistant: assistantReply });
    if (session.history.length > maxTurns) {
      session.history.splice(0, session.history.length - maxTurns);
    }
    session.lastActiveAt = now();
    sessions.delete(id);
    sessions.set(id, session);
    return true;
  }

  function deleteSession(id) {
    return sessions.delete(id);
  }

  return { create, getHistory, append, deleteSession, prune, size: () => sessions.size };
}

module.exports = {
  createConversationStore,
  MAX_SESSIONS,
  MAX_TURNS_PER_SESSION,
  SESSION_TTL_MS
};
