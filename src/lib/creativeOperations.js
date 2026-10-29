// Shared for one browser runtime, across editor unmount/remount. Server-side
// revision/ownership checks remain authoritative across tabs and devices.
const pending = new Map();
const listeners = new Set();
const keyFor = (podId, postId) => JSON.stringify([podId, postId]);
const notify = () => { for (const listener of listeners) listener(); };

export function subscribeCreativeOperations(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isCreativeOperationPending(podId, postId) {
  return pending.has(keyFor(podId, postId));
}

export async function runCreativeOperation(podId, postId, operation) {
  const key = keyFor(podId, postId);
  const previous = pending.get(key);
  const current = (previous || Promise.resolve()).catch(() => {}).then(operation);
  pending.set(key, current);
  notify();
  try { return await current; } finally {
    if (pending.get(key) === current) { pending.delete(key); notify(); }
  }
}
