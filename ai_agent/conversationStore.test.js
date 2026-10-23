'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConversationStore } = require('./conversationStore');

test('conversation sessions are isolated and starting a new one leaves prior session separate', () => {
  const store = createConversationStore();
  const first = store.create();
  const second = store.create();
  store.append(first, 'first user', 'first reply');
  store.append(second, 'second user', 'second reply');

  assert.notEqual(first, second);
  assert.deepEqual(store.getHistory(first), [{ user: 'first user', assistant: 'first reply' }]);
  assert.deepEqual(store.getHistory(second), [{ user: 'second user', assistant: 'second reply' }]);
});

test('history is bounded and inactive sessions expire', () => {
  let time = 1000;
  const store = createConversationStore({ maxTurns: 2, ttlMs: 50, now: () => time });
  const id = store.create();
  store.append(id, 'u1', 'a1');
  store.append(id, 'u2', 'a2');
  store.append(id, 'u3', 'a3');
  assert.deepEqual(store.getHistory(id), [
    { user: 'u2', assistant: 'a2' },
    { user: 'u3', assistant: 'a3' }
  ]);

  time += 51;
  assert.equal(store.getHistory(id), null);
});

test('a new conversation can explicitly discard its old session', () => {
  const store = createConversationStore();
  const oldId = store.create();
  store.append(oldId, 'sensitive context', 'prior reply');
  assert.equal(store.deleteSession(oldId), true);
  assert.equal(store.getHistory(oldId), null);
});
