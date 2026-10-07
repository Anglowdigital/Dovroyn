-- Dovroyn Supabase Database Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- Waitlist table
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'starter', 'growth', 'pro', 'scale')),
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'cancelled', 'past_due')),
  current_period_end TIMESTAMPTZ,
  max_pods INTEGER NOT NULL DEFAULT 0,
  monthly_content_days INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_idx ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_stripe_sub_idx ON subscriptions(stripe_subscription_id);

-- Pods table
CREATE TABLE IF NOT EXISTS pods (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_name TEXT NOT NULL,
  brand_name TEXT,
  pod_type TEXT NOT NULL DEFAULT 'website' CHECK (pod_type IN ('website', 'app', 'product', 'campaign', 'images', 'teaser', 'brand')),
  source_type TEXT,
  source_url TEXT,
  target_country TEXT DEFAULT 'Australia',
  accepted_tone TEXT,
  accepted_strategy TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'analysing', 'awaiting_direction', 'direction_locked', 'active', 'paused', 'archived')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pods_user_id_idx ON pods(user_id);

-- Pod sources table
CREATE TABLE IF NOT EXISTS pod_sources (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pod_id UUID REFERENCES pods(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_url TEXT,
  uploaded_file_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pod_sources_pod_id_idx ON pod_sources(pod_id);

-- Pod analysis table
CREATE TABLE IF NOT EXISTS pod_analysis (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pod_id UUID REFERENCES pods(id) ON DELETE CASCADE,
  brand_summary TEXT,
  tone TEXT,
  audience TEXT,
  offer_direction TEXT,
  campaign_angles TEXT,
  content_ideas TEXT,
  ad_angles TEXT,
  social_recommendations TEXT,
  calendar_strategy TEXT,
  budget_strategy TEXT,
  next_actions TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pod_analysis_pod_id_idx ON pod_analysis(pod_id);

-- Calendar items table
CREATE TABLE IF NOT EXISTS calendar_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pod_id UUID REFERENCES pods(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  content_type TEXT NOT NULL,
  caption TEXT,
  creative_note TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'scheduled', 'posted', 'failed')),
  approved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_items_pod_id_idx ON calendar_items(pod_id);
CREATE INDEX IF NOT EXISTS calendar_items_date_idx ON calendar_items(scheduled_date);

-- Budgets table
CREATE TABLE IF NOT EXISTS budgets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pod_id UUID REFERENCES pods(id) ON DELETE CASCADE,
  planned_budget NUMERIC(10,2) DEFAULT 0,
  spend_used NUMERIC(10,2) DEFAULT 0,
  leads INTEGER DEFAULT 0,
  sales INTEGER DEFAULT 0,
  revenue NUMERIC(10,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS budgets_pod_id_idx ON budgets(pod_id);

-- Ad analysis table
CREATE TABLE IF NOT EXISTS ad_analysis (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pod_id UUID REFERENCES pods(id) ON DELETE CASCADE,
  performance_summary TEXT,
  competitor_notes TEXT,
  recommendation TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_analysis_pod_id_idx ON ad_analysis(pod_id);

-- User settings table
CREATE TABLE IF NOT EXISTS user_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  workspace_name TEXT DEFAULT 'Dovroyn Pod Command Centre',
  theme TEXT DEFAULT 'Editorial Ivory and Navy',
  timezone TEXT DEFAULT 'UTC',
  email_notifications BOOLEAN DEFAULT true,
  weekly_digest BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security (RLS)
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pods ENABLE ROW LEVEL SECURITY;
ALTER TABLE pod_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE pod_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- The existing waitlist belongs to the earlier launch flow and is left untouched.
-- Dovroyn no longer creates a second permissive waitlist policy here.

-- Subscriptions: users can read their own
DROP POLICY IF EXISTS "Users can view own subscription" ON subscriptions;
CREATE POLICY "Users can view own subscription" ON subscriptions FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

-- Pods: users can CRUD their own
DROP POLICY IF EXISTS "Users can view own pods" ON pods;
DROP POLICY IF EXISTS "Users can create pods" ON pods;
DROP POLICY IF EXISTS "Users can update own pods" ON pods;
DROP POLICY IF EXISTS "Users can delete own pods" ON pods;
CREATE POLICY "Users can view own pods" ON pods FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can create pods" ON pods FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own pods" ON pods FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete own pods" ON pods FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

-- Pod sources: users can CRUD via pod ownership
DROP POLICY IF EXISTS "Users can view own pod sources" ON pod_sources;
DROP POLICY IF EXISTS "Users can create pod sources" ON pod_sources;
DROP POLICY IF EXISTS "Users can update own pod sources" ON pod_sources;
DROP POLICY IF EXISTS "Users can delete own pod sources" ON pod_sources;
CREATE POLICY "Users can view own pod sources" ON pod_sources FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_sources.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can create pod sources" ON pod_sources FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_sources.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can update own pod sources" ON pod_sources FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_sources.pod_id AND pods.user_id = (SELECT auth.uid()))) WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_sources.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can delete own pod sources" ON pod_sources FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_sources.pod_id AND pods.user_id = (SELECT auth.uid())));

-- Pod analysis: same pattern
DROP POLICY IF EXISTS "Users can view own pod analysis" ON pod_analysis;
DROP POLICY IF EXISTS "Users can create pod analysis" ON pod_analysis;
DROP POLICY IF EXISTS "Users can update own pod analysis" ON pod_analysis;
CREATE POLICY "Users can view own pod analysis" ON pod_analysis FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_analysis.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can create pod analysis" ON pod_analysis FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_analysis.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can update own pod analysis" ON pod_analysis FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_analysis.pod_id AND pods.user_id = (SELECT auth.uid()))) WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = pod_analysis.pod_id AND pods.user_id = (SELECT auth.uid())));

-- Calendar items: same pattern
DROP POLICY IF EXISTS "Users can view own calendar items" ON calendar_items;
DROP POLICY IF EXISTS "Users can create calendar items" ON calendar_items;
DROP POLICY IF EXISTS "Users can update own calendar items" ON calendar_items;
DROP POLICY IF EXISTS "Users can delete own calendar items" ON calendar_items;
CREATE POLICY "Users can view own calendar items" ON calendar_items FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = calendar_items.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can create calendar items" ON calendar_items FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = calendar_items.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can update own calendar items" ON calendar_items FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = calendar_items.pod_id AND pods.user_id = (SELECT auth.uid()))) WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = calendar_items.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can delete own calendar items" ON calendar_items FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = calendar_items.pod_id AND pods.user_id = (SELECT auth.uid())));

-- Budgets: same pattern
DROP POLICY IF EXISTS "Users can view own budgets" ON budgets;
DROP POLICY IF EXISTS "Users can create budgets" ON budgets;
DROP POLICY IF EXISTS "Users can update own budgets" ON budgets;
CREATE POLICY "Users can view own budgets" ON budgets FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = budgets.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can create budgets" ON budgets FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = budgets.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can update own budgets" ON budgets FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = budgets.pod_id AND pods.user_id = (SELECT auth.uid()))) WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = budgets.pod_id AND pods.user_id = (SELECT auth.uid())));

-- Ad analysis: same pattern
DROP POLICY IF EXISTS "Users can view own ad analysis" ON ad_analysis;
DROP POLICY IF EXISTS "Users can create ad analysis" ON ad_analysis;
DROP POLICY IF EXISTS "Users can update own ad analysis" ON ad_analysis;
CREATE POLICY "Users can view own ad analysis" ON ad_analysis FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = ad_analysis.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can create ad analysis" ON ad_analysis FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = ad_analysis.pod_id AND pods.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can update own ad analysis" ON ad_analysis FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM pods WHERE pods.id = ad_analysis.pod_id AND pods.user_id = (SELECT auth.uid()))) WITH CHECK (EXISTS (SELECT 1 FROM pods WHERE pods.id = ad_analysis.pod_id AND pods.user_id = (SELECT auth.uid())));

-- User settings: users can CRUD their own
DROP POLICY IF EXISTS "Users can view own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can create own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can update own settings" ON user_settings;
CREATE POLICY "Users can view own settings" ON user_settings FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can create own settings" ON user_settings FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own settings" ON user_settings FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- Additive columns for existing deployments (safe to run on already-created databases)
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE pods ADD COLUMN IF NOT EXISTS brand_name TEXT;
ALTER TABLE pods ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE pods ADD COLUMN IF NOT EXISTS accepted_strategy TEXT;
ALTER TABLE calendar_items ADD COLUMN IF NOT EXISTS creative_note TEXT;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS notes TEXT;

-- Explicit Data API grants avoid relying on project-wide defaults.
GRANT SELECT ON TABLE subscriptions TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE subscriptions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  pods, pod_sources, pod_analysis, calendar_items, budgets, ad_analysis, user_settings
TO authenticated;


