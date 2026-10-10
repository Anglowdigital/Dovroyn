import { isPodDirectionApprovalCurrent } from '../../src/lib/podDirection.js';
import { PLAN_ENTITLEMENTS, hasActivePaidAccess } from '../../src/lib/plans.js';

export const ACTION_LEVELS = Object.freeze(['research', 'draft', 'approve', 'execute']);

const EXTERNAL_ACTIONS = new Set(['publish_post', 'schedule_post', 'launch_ad', 'change_ad_spend', 'connect_account']);

export function hasApprovedPodDirection(pod, preferences = []) {
  return isPodDirectionApprovalCurrent(pod, preferences);
}

// Keep client-requested action data separate from state read and confirmed by
// Dovroyn's server. Callers must build trustedContext from stored approvals,
// subscription data and provider connections, never from the request body.
export function evaluateAgentAction(request = {}, trustedContext = {}) {
  const level = String(request.level || 'research');
  if (!ACTION_LEVELS.includes(level)) return { allowed: false, reason: 'Unknown action level.' };

  if (level !== 'execute') return { allowed: true, level, externalEffect: false };
  if (!EXTERNAL_ACTIONS.has(request.actionType)) return { allowed: false, reason: 'Execution action is not allowlisted.' };
  if (!trustedContext.approvedByHuman) return { allowed: false, reason: 'Human approval is required.' };
  const isConnectionIntent = request.actionType === 'connect_account';
  if (isConnectionIntent) {
    if (!trustedContext.providerSetupReady) {
      return { allowed: false, reason: 'Official provider setup must be confirmed before authorization can begin.' };
    }
  } else if (!trustedContext.connectionActive) {
    return { allowed: false, reason: 'An active platform connection is required.' };
  }
  if (!request.idempotencyKey || String(request.idempotencyKey).trim().length < 12) {
    return { allowed: false, reason: 'A stable idempotency key is required.' };
  }
  if (isConnectionIntent) {
    if (!request.requestedProviderKey || !trustedContext.trustedProviderKey) {
      return { allowed: false, reason: 'A configured OAuth provider is required.' };
    }
    if (request.requestedProviderKey !== trustedContext.trustedProviderKey) {
      return { allowed: false, reason: 'Untrusted input cannot override the configured OAuth provider.' };
    }
  } else {
    if (!trustedContext.trustedTargetId) return { allowed: false, reason: 'A trusted platform target is required.' };
    if (request.requestedTargetId && request.requestedTargetId !== trustedContext.trustedTargetId) {
      return { allowed: false, reason: 'Untrusted input cannot override the connected platform target.' };
    }
  }
  const tier = String(trustedContext.subscription?.tier || '');
  const recognizedPaidTier = tier !== 'free' && Object.hasOwn(PLAN_ENTITLEMENTS, tier);
  if (!recognizedPaidTier || !hasActivePaidAccess(trustedContext.subscription)) {
    return { allowed: false, reason: 'A current paid subscription is required.' };
  }
  if (trustedContext.actionEntitled !== true) {
    return { allowed: false, reason: 'A server-confirmed action entitlement is required.' };
  }
  return { allowed: true, level, externalEffect: true };
}

