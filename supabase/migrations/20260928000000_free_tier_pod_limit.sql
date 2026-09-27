-- Free-tier pod limit fix (2026-09-28)
-- The original enforce_pod_limit trigger mapped "no active subscription" to a
-- limit of 0 and raised on every pods INSERT, which contradicted the product's
-- free tier (1 pod). This patch recreates the trigger so:
--   - no active subscription row  -> 1 free pod
--   - active tier                 -> starter 1 / growth 3 / pro 7 / scale 12
--   - active but unknown tier     -> 1 (safe fallback)
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION private.enforce_pod_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  plan_limit INTEGER;
  active_count INTEGER;
BEGIN
  IF NEW.user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Pod owner must match the authenticated user';
  END IF;

  -- The free tier allows 1 pod; an active paid subscription sets its tier limit.
  SELECT CASE subscription.tier
    WHEN 'starter' THEN 1 WHEN 'growth' THEN 3 WHEN 'pro' THEN 7 WHEN 'scale' THEN 12 ELSE 1
  END INTO plan_limit
  FROM public.subscriptions subscription
  WHERE subscription.user_id = NEW.user_id
    AND subscription.status IN ('active', 'trialing')
    AND subscription.current_period_end > now();

  -- Free users (no active subscription row) still get their 1 free pod.
  plan_limit := COALESCE(plan_limit, 1);

  SELECT count(*) INTO active_count FROM public.pods pod
  WHERE pod.user_id = NEW.user_id AND pod.status <> 'archived';

  IF active_count >= plan_limit THEN
    RAISE EXCEPTION 'Pod limit reached for this subscription tier';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_pod_limit_before_insert ON public.pods;
CREATE TRIGGER enforce_pod_limit_before_insert
BEFORE INSERT ON public.pods
FOR EACH ROW EXECUTE FUNCTION private.enforce_pod_limit();
