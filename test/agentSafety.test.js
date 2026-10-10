import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAgentAction, hasApprovedPodDirection } from '../api/_lib/agentSafety.js';
import { buildAnalysisProvenance } from '../api/_lib/analysisEvidence.js';

const activePaidSubscription = Object.freeze({
  tier: 'starter',
  status: 'active',
  current_period_end: '2099-01-01T00:00:00.000Z',
});

const executableAction = (overrides = {}) => ({
  level: 'execute',
  actionType: 'schedule_post',
  idempotencyKey: 'post:scheduled:123',
  requestedTargetId: 'page-123',
  ...overrides,
});

const trustedExecutionContext = Object.freeze({
  approvedByHuman: true,
  connectionActive: true,
  actionEntitled: true,
  subscription: activePaidSubscription,
  trustedTargetId: 'page-123',
});

test('research has no external effect', () => {
  assert.deepEqual(evaluateAgentAction({ level: 'research' }), { allowed: true, level: 'research', externalEffect: false });
});

test('drafting has no external effect', () => {
  assert.deepEqual(evaluateAgentAction({ level: 'draft' }), { allowed: true, level: 'draft', externalEffect: false });
});

test('content drafting requires a server-confirmed approved pod direction', () => {
  assert.equal(hasApprovedPodDirection({ status: 'direction_locked' }), true);
  assert.equal(hasApprovedPodDirection({ status: 'active' }), true);
  const latest = [{
    active: true,
    preference_type: 'brand_direction',
    preference_value: { value: 'New direction' },
    created_at: '2026-09-30T01:00:00.000Z',
  }];
  assert.equal(hasApprovedPodDirection({ status: 'direction_locked', accepted_tone: 'Old direction' }, latest), false);
  assert.equal(hasApprovedPodDirection({ status: 'direction_locked', accepted_tone: 'New direction' }, latest), true);
  assert.equal(hasApprovedPodDirection({ status: 'awaiting_direction' }), false);
  assert.equal(hasApprovedPodDirection(null), false);
});

test('unknown action levels fail closed', () => {
  assert.equal(evaluateAgentAction({ level: 'autonomous' }).allowed, false);
});

test('execution requires human approval', () => {
  const result = evaluateAgentAction({ level: 'execute', actionType: 'publish_post' });
  assert.match(result.reason, /Human approval/);
});

test('execution requires an active provider connection', () => {
  const result = evaluateAgentAction(
    { level: 'execute', actionType: 'publish_post' },
    { approvedByHuman: true },
  );
  assert.match(result.reason, /active platform connection/);
});

test('execution accepts only allowlisted action types', () => {
  const result = evaluateAgentAction({ level: 'execute', actionType: 'delete_account' });
  assert.match(result.reason, /not allowlisted/);
});

test('execution requires an idempotency key', () => {
  const result = evaluateAgentAction(
    { level: 'execute', actionType: 'publish_post' },
    { approvedByHuman: true, connectionActive: true },
  );
  assert.match(result.reason, /idempotency/);
});

test('execution requires a current recognized paid subscription', () => {
  const invalidSubscriptions = [
    undefined,
    { tier: 'free', status: 'active', current_period_end: '2099-01-01T00:00:00.000Z' },
    { tier: 'invented', status: 'active', current_period_end: '2099-01-01T00:00:00.000Z' },
    { tier: 'starter', status: 'past_due', current_period_end: '2099-01-01T00:00:00.000Z' },
    { tier: 'starter', status: 'active', current_period_end: '2020-01-01T00:00:00.000Z' },
  ];

  for (const subscription of invalidSubscriptions) {
    const result = evaluateAgentAction(executableAction(), { ...trustedExecutionContext, subscription });
    assert.match(result.reason, /current paid subscription/);
  }
});

test('execution requires an explicit server-confirmed action entitlement', () => {
  const result = evaluateAgentAction(executableAction(), { ...trustedExecutionContext, actionEntitled: false });
  assert.match(result.reason, /action entitlement/);
});

test('untrusted request fields cannot manufacture trusted execution state', () => {
  const result = evaluateAgentAction({
    ...executableAction(),
    approvedByHuman: true,
    connectionActive: true,
    actionEntitled: true,
    subscription: activePaidSubscription,
    trustedTargetId: 'page-123',
  });
  assert.match(result.reason, /Human approval/);
});

test('untrusted input cannot replace the connected target', () => {
  const result = evaluateAgentAction(
    executableAction({ actionType: 'launch_ad', idempotencyKey: 'launch:campaign:123', requestedTargetId: 'attacker-account' }),
    { ...trustedExecutionContext, trustedTargetId: 'ad-account-safe' },
  );
  assert.match(result.reason, /cannot override/);
});

test('a fully authorized execution is allowed', () => {
  const result = evaluateAgentAction(executableAction(), trustedExecutionContext);
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

