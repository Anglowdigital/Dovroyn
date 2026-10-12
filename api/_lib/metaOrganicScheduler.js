import { createMetaGraphOrganicProvider } from './metaOrganicProvider.js';
import {
  META_ORGANIC_SCHEDULER_DISABLED_REASON,
  META_ORGANIC_SCHEDULER_NOT_READY_REASON,
  META_ORGANIC_SCHEDULER_UNAUTHORIZED_REASON,
  createRpcMetaOrganicPublishStore,
  getMetaOrganicPublisherConfig,
  processNextMetaOrganicPublishJob,
  reconcileNextMetaOrganicPublishJob,
} from './metaOrganicPublisher.js';

const DEFAULT_BATCH_LIMIT = 5;
const DEFAULT_BUDGET_MS = 25_000;

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function bearer(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  const [scheme, token] = String(header).split(' ');
  return scheme?.toLowerCase() === 'bearer' ? token : '';
}

export function getMetaOrganicSchedulerConfig(env = process.env) {
  const secret = cleanString(env.META_ORGANIC_SCHEDULER_SECRET || env.CRON_SECRET, 500);
  return {
    enabled: env.META_ORGANIC_SCHEDULER_ENABLED === 'true',
    secretConfigured: Boolean(secret),
    secret,
    batchLimit: Number.isInteger(Number(env.META_ORGANIC_SCHEDULER_BATCH_LIMIT))
      ? Math.max(1, Math.min(20, Number(env.META_ORGANIC_SCHEDULER_BATCH_LIMIT)))
      : DEFAULT_BATCH_LIMIT,
    budgetMs: Number.isInteger(Number(env.META_ORGANIC_SCHEDULER_BUDGET_MS))
      ? Math.max(5_000, Math.min(55_000, Number(env.META_ORGANIC_SCHEDULER_BUDGET_MS)))
      : DEFAULT_BUDGET_MS,
  };
}

export function authorizeMetaOrganicScheduler(req, config = getMetaOrganicSchedulerConfig()) {
  if (!config.enabled) return { ok: false, status: 200, body: { status: 'disabled', reason: META_ORGANIC_SCHEDULER_DISABLED_REASON } };
  if (!config.secretConfigured) return { ok: false, status: 503, body: { status: 'unavailable', reason: META_ORGANIC_SCHEDULER_UNAUTHORIZED_REASON } };
  if (bearer(req) !== config.secret) return { ok: false, status: 401, body: { status: 'unauthorized', reason: META_ORGANIC_SCHEDULER_UNAUTHORIZED_REASON } };
  return { ok: true };
}

export async function runMetaOrganicScheduler({
  req = null,
  schedulerConfig = getMetaOrganicSchedulerConfig(),
  publisherConfig = getMetaOrganicPublisherConfig(),
  store = null,
  provider = null,
  providerFactory = createMetaGraphOrganicProvider,
  now = new Date(),
  workerId = `meta-scheduler-${process.pid}`,
} = {}) {
  const auth = authorizeMetaOrganicScheduler(req, schedulerConfig);
  if (!auth.ok) return auth.body;
  if (!publisherConfig.enabled) return { status: 'disabled', reason: META_ORGANIC_SCHEDULER_DISABLED_REASON };
  const activeStore = store || createRpcMetaOrganicPublishStore();
  if (typeof activeStore.readiness === 'function') {
    const ready = await activeStore.readiness();
    if (!ready?.ready) return { status: 'unavailable', reason: META_ORGANIC_SCHEDULER_NOT_READY_REASON };
  } else {
    return { status: 'unavailable', reason: META_ORGANIC_SCHEDULER_NOT_READY_REASON };
  }
  const started = now.getTime();
  const deadlineMs = started + Math.min(schedulerConfig.budgetMs, Math.max(1, publisherConfig.leaseMs - 5_000));
  const deadlineAt = new Date(deadlineMs).toISOString();
  if (Date.now() >= deadlineMs) return { status: 'ok', publish: [], reconcile: [] };
  const activeProvider = provider || providerFactory();
  const publish = [];
  const reconcile = [];
  for (let i = 0; i < schedulerConfig.batchLimit; i += 1) {
    if (Date.now() >= deadlineMs) break;
    const result = await processNextMetaOrganicPublishJob({
      config: publisherConfig,
      store: activeStore,
      provider: activeProvider,
      workerId: `${workerId}-publish`,
      now: new Date(),
      deadlineAt,
    });
    publish.push(result);
    if (['idle', 'disabled'].includes(result.status)) break;
  }
  for (let i = 0; i < schedulerConfig.batchLimit; i += 1) {
    if (Date.now() >= deadlineMs) break;
    const result = await reconcileNextMetaOrganicPublishJob({
      config: publisherConfig,
      store: activeStore,
      provider: activeProvider,
      workerId: `${workerId}-reconcile`,
      now: new Date(),
      deadlineAt,
    });
    reconcile.push(result);
    if (['idle', 'disabled'].includes(result.status)) break;
  }
  return {
    status: 'ok',
    publish,
    reconcile,
  };
}
