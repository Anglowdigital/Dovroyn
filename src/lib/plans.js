const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const PLAN_CURRENCY = 'AUD';
const priceFormatter = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: PLAN_CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export const PLAN_ENTITLEMENTS = Object.freeze({
  free: Object.freeze({
    key: 'free',
    name: 'Free',
    monthlyPrice: 0,
    yearlyPrice: 0,
    maxPods: 1,
    monthlyContentDays: 0,
    weeklyPostingDays: 0,
  }),
  starter: Object.freeze({
    key: 'starter',
    name: 'Starter Pod',
    monthlyPrice: 89,
    yearlyPrice: 855,
    maxPods: 1,
    monthlyContentDays: 10,
    weeklyPostingDays: 2,
  }),
  growth: Object.freeze({
    key: 'growth',
    name: 'Growth Pods',
    monthlyPrice: 249,
    yearlyPrice: 2390,
    maxPods: 3,
    monthlyContentDays: 20,
    weeklyPostingDays: 3,
  }),
  pro: Object.freeze({
    key: 'pro',
    name: 'Pro Marketing Pods',
    monthlyPrice: 599,
    yearlyPrice: 5750,
    maxPods: 7,
    monthlyContentDays: 30,
    weeklyPostingDays: 6,
  }),
  scale: Object.freeze({
    key: 'scale',
    name: 'Scale / Agency Pods',
    monthlyPrice: 1299,
    yearlyPrice: 12470,
    maxPods: 12,
    monthlyContentDays: 30,
    weeklyPostingDays: 7,
  }),
});

export const TIER_LIMITS = Object.freeze(
  Object.fromEntries(
    Object.entries(PLAN_ENTITLEMENTS).map(([key, plan]) => [key, Object.freeze({
      maxPods: plan.maxPods,
      monthlyContentDays: plan.monthlyContentDays,
      weeklyPostingDays: plan.weeklyPostingDays,
    })]),
  ),
);

export function getPlan(tier = 'free') {
  return PLAN_ENTITLEMENTS[tier] || PLAN_ENTITLEMENTS.free;
}

export function formatPlanPrice(tier, billing = 'monthly') {
  const plan = getPlan(tier);
  const amount = billing === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice;
  return `${PLAN_CURRENCY} ${priceFormatter.format(amount)}`;
}

export function getPlanSelection(search) {
  const params = new URLSearchParams(search);
  const tier = params.get('plan');
  const billing = params.get('billing') || 'monthly';
  if (!Object.hasOwn(PLAN_ENTITLEMENTS, tier) || tier === 'free' || !['monthly', 'yearly'].includes(billing)) return null;
  return { tier, billing };
}

export function getPlanSelectionQuery(tier, billing = 'monthly') {
  return getPlanSelection(new URLSearchParams({ plan: tier, billing }))
    ? `?plan=${tier}&billing=${billing}`
    : '';
}

export function canCreatePod(tier, currentPodCount) {
  return currentPodCount < getPlan(tier).maxPods;
}

export function getContentDays(tier) {
  return getPlan(tier).monthlyContentDays;
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function addUtcMonthsClamped(input, months) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid date is required.');

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const targetDay = Math.min(date.getUTCDate(), daysInUtcMonth(targetYear, targetMonth));

  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
}

export function getMonthlyAllowanceWindow(subscriptionStartedAt, at = new Date()) {
  const startedAt = new Date(subscriptionStartedAt);
  const current = new Date(at);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(current.getTime())) {
    throw new TypeError('Valid subscription and current dates are required.');
  }
  if (current < startedAt) return { startsAt: startedAt, endsAt: addUtcMonthsClamped(startedAt, 1) };

  let roughMonths = Math.max(0, Math.floor((current - startedAt) / (28 * DAY_IN_MS)) - 1);
  let startsAt = addUtcMonthsClamped(startedAt, roughMonths);
  let endsAt = addUtcMonthsClamped(startedAt, roughMonths + 1);

  while (current >= endsAt) {
    startsAt = endsAt;
    endsAt = addUtcMonthsClamped(subscriptionStartedAt, roughMonths + 2);
    roughMonths += 1;
  }

  while (current < startsAt) {
    roughMonths -= 1;
    startsAt = addUtcMonthsClamped(subscriptionStartedAt, roughMonths);
    endsAt = addUtcMonthsClamped(subscriptionStartedAt, roughMonths + 1);
  }

  return { startsAt, endsAt };
}

export function hasActivePaidAccess(subscription, at = new Date()) {
  if (!subscription || !['active', 'trialing'].includes(subscription.status)) return false;
  if (!subscription.current_period_end) return false;
  return new Date(subscription.current_period_end) > new Date(at);
}
