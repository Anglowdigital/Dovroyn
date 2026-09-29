import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit } from '../api/_lib/rateLimit.js';

test('rate limits allow the configured number of requests and then fail closed', () => {
  const key = `test:${crypto.randomUUID()}`;
  assert.equal(checkRateLimit(key, { limit: 3, windowMs: 60000 }).allowed, true);
  assert.equal(checkRateLimit(key, { limit: 3, windowMs: 60000 }).allowed, true);
  assert.equal(checkRateLimit(key, { limit: 3, windowMs: 60000 }).allowed, true);
  assert.equal(checkRateLimit(key, { limit: 3, windowMs: 60000 }).allowed, false);
});
