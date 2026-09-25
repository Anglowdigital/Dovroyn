export const ACTION_LEVELS = Object.freeze(['research', 'draft', 'approve', 'execute']);

const EXTERNAL_ACTIONS = new Set(['publish_post', 'schedule_post', 'launch_ad', 'change_ad_spend', 'connect_account']);

export function evaluateAgentAction(request = {}) {
  const level = String(request.level || 'research');
  if (!ACTION_LEVELS.includes(level)) return { allowed: false, reason: 'Unknown action level.' };

  if (level !== 'execute') return { allowed: true, level, externalEffect: false };
  if (!EXTERNAL_ACTIONS.has(request.actionType)) return { allowed: false, reason: 'Execution action is not allowlisted.' };
  if (!request.approvedByHuman) return { allowed: false, reason: 'Human approval is required.' };
  if (!request.connectionActive) return { allowed: false, reason: 'An active platform connection is required.' };
  if (!request.idempotencyKey || String(request.idempotencyKey).trim().length < 12) {
    return { allowed: false, reason: 'A stable idempotency key is required.' };
  }
  if (!request.trustedTargetId) return { allowed: false, reason: 'A trusted platform target is required.' };
  if (request.requestedTargetId && request.requestedTargetId !== request.trustedTargetId) {
    return { allowed: false, reason: 'Untrusted input cannot override the connected platform target.' };
  }
  return { allowed: true, level, externalEffect: true };
}

