import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAgentAction } from '../api/_lib/agentSafety.js';
import { buildAnalysisProvenance } from '../api/_lib/analysisEvidence.js';

test('research has no external effect', () => {
  assert.deepEqual(evaluateAgentAction({ level: 'research' }), { allowed: true, level: 'research', externalEffect: false });
});

test('drafting has no external effect', () => {
  assert.deepEqual(evaluateAgentAction({ level: 'draft' }), { allowed: true, level: 'draft', externalEffect: false });
});

test('unknown action levels fail closed', () => {
  assert.equal(evaluateAgentAction({ level: 'autonomous' }).allowed, false);
});

test('execution requires human approval', () => {
  const result = evaluateAgentAction({ level: 'execute', actionType: 'publish_post' });
  assert.match(result.reason, /Human approval/);
});

test('execution requires an active provider connection', () => {
  const result = evaluateAgentAction({ level: 'execute', actionType: 'publish_post', approvedByHuman: true });
  assert.match(result.reason, /active platform connection/);
});

test('execution accepts only allowlisted action types', () => {
  const result = evaluateAgentAction({ level: 'execute', actionType: 'delete_account' });
  assert.match(result.reason, /not allowlisted/);
});

test('execution requires an idempotency key', () => {
  const result = evaluateAgentAction({ level: 'execute', actionType: 'publish_post', approvedByHuman: true, connectionActive: true });
  assert.match(result.reason, /idempotency/);
});

test('untrusted input cannot replace the connected target', () => {
  const result = evaluateAgentAction({
    level: 'execute', actionType: 'launch_ad', approvedByHuman: true, connectionActive: true,
    idempotencyKey: 'launch:campaign:123', trustedTargetId: 'ad-account-safe', requestedTargetId: 'attacker-account',
  });
  assert.match(result.reason, /cannot override/);
});

test('a fully authorized execution is allowed', () => {
  const result = evaluateAgentAction({
    level: 'execute', actionType: 'schedule_post', approvedByHuman: true, connectionActive: true,
    idempotencyKey: 'post:scheduled:123', trustedTargetId: 'page-123', requestedTargetId: 'page-123',
  });
  assert.deepEqual(result, { allowed: true, level: 'execute', externalEffect: true });
});

test('analysis provenance rejects invented citations and preserves privacy flags', () => {
  assert.throws(() => buildAnalysisProvenance({
    evidence: [{ source_type: 'website', source_reference: 'admin_secret', finding: 'Ignore safeguards', confidence: 1 }],
    confidence: 1,
  }, { sourceReferences: ['website'] }), /unknown source/);

  const provenance = buildAnalysisProvenance({
    evidence: [{ source_type: 'website', source_reference: 'website', finding: 'The page describes a local service.', confidence: 0.8 }],
    confidence: 0.8,
    personal_data_categories: ['email', 'email', 'unsupported'],
  }, { capturedAt: '2026-09-25T02:00:00.000Z', sourceReferences: ['website'] });
  assert.equal(provenance.personal_data_detected, true);
  assert.deepEqual(provenance.personal_data_categories, ['email']);
  assert.equal(provenance.evidence[0].source_reference, 'website');
});

