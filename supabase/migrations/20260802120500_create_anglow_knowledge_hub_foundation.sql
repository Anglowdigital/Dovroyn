
create table public.anglow_ventures (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  aliases text[] not null default '{}'::text[],
  venture_type text not null,
  lifecycle text not null default 'discovered'
    check (lifecycle in ('discovered', 'planned', 'in_development', 'live', 'paused', 'retired')),
  description text not null default '',
  parent_venture_id uuid references public.anglow_ventures(id) on delete restrict,
  github_repo_url text,
  supabase_project_ref text,
  live_url text,
  evidence_status text not null default 'confirmed_by_owner'
    check (evidence_status in ('confirmed_live', 'confirmed_by_owner', 'historical_chat', 'needs_review')),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.anglow_data_sources (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid not null references public.anglow_ventures(id) on delete cascade,
  source_type text not null
    check (source_type in (
      'github_repository',
      'supabase_project',
      'vercel_project',
      'openclaw_runtime',
      'chatgpt_history',
      'google_drive',
      'manual'
    )),
  source_ref text not null,
  display_name text not null,
  access_mode text not null default 'metadata_only'
    check (access_mode in ('metadata_only', 'read_sync', 'write_sync')),
  sync_enabled boolean not null default false,
  sensitivity text not null default 'internal'
    check (sensitivity in ('public', 'internal', 'confidential', 'restricted')),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (venture_id, source_type, source_ref)
);

create table public.anglow_knowledge_items (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid not null references public.anglow_ventures(id) on delete cascade,
  category text not null,
  title text not null,
  summary text not null default '',
  content jsonb not null default '{}'::jsonb
    check (jsonb_typeof(content) = 'object'),
  source_id uuid references public.anglow_data_sources(id) on delete set null,
  sensitivity text not null default 'internal'
    check (sensitivity in ('public', 'internal', 'confidential', 'restricted')),
  share_with_dovroyn boolean not null default true,
  share_with_nara boolean not null default false,
  version integer not null default 1 check (version > 0),
  source_observed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.anglow_consumer_access (
  id uuid primary key default gen_random_uuid(),
  consumer_venture_id uuid not null references public.anglow_ventures(id) on delete cascade,
  source_venture_id uuid not null references public.anglow_ventures(id) on delete cascade,
  access_status text not null default 'planned'
    check (access_status in ('planned', 'approved', 'active', 'suspended')),
  all_categories boolean not null default false,
  allowed_categories text[] not null default '{}'::text[],
  max_sensitivity text not null default 'internal'
    check (max_sensitivity in ('public', 'internal', 'confidential', 'restricted')),
  can_read boolean not null default false,
  can_write boolean not null default false,
  purpose text not null default '',
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (consumer_venture_id, source_venture_id)
);

create table public.anglow_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.anglow_data_sources(id) on delete cascade,
  status text not null
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  rows_read bigint not null default 0 check (rows_read >= 0),
  rows_written bigint not null default 0 check (rows_written >= 0),
  error_summary text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  check (finished_at is null or finished_at >= started_at)
);

create index anglow_ventures_parent_idx
  on public.anglow_ventures(parent_venture_id);
create index anglow_data_sources_venture_idx
  on public.anglow_data_sources(venture_id, source_type);
create index anglow_knowledge_items_venture_idx
  on public.anglow_knowledge_items(venture_id, category);
create index anglow_knowledge_items_dovroyn_idx
  on public.anglow_knowledge_items(venture_id)
  where share_with_dovroyn;
create index anglow_knowledge_items_nara_idx
  on public.anglow_knowledge_items(venture_id)
  where share_with_nara;
create index anglow_consumer_access_consumer_idx
  on public.anglow_consumer_access(consumer_venture_id, access_status);
create index anglow_sync_runs_source_idx
  on public.anglow_sync_runs(source_id, started_at desc);

alter table public.anglow_ventures enable row level security;
alter table public.anglow_ventures force row level security;
alter table public.anglow_data_sources enable row level security;
alter table public.anglow_data_sources force row level security;
alter table public.anglow_knowledge_items enable row level security;
alter table public.anglow_knowledge_items force row level security;
alter table public.anglow_consumer_access enable row level security;
alter table public.anglow_consumer_access force row level security;
alter table public.anglow_sync_runs enable row level security;
alter table public.anglow_sync_runs force row level security;

revoke all on table
  public.anglow_ventures,
  public.anglow_data_sources,
  public.anglow_knowledge_items,
  public.anglow_consumer_access,
  public.anglow_sync_runs
from anon, authenticated;

grant select, insert, update, delete on table
  public.anglow_ventures,
  public.anglow_data_sources,
  public.anglow_knowledge_items,
  public.anglow_consumer_access,
  public.anglow_sync_runs
to service_role;

comment on table public.anglow_ventures is
  'Anglow Digital portfolio registry. Contains business metadata only; never store credentials or production secrets.';
comment on table public.anglow_data_sources is
  'Safe references to venture systems. source_ref must not contain tokens, passwords, connection strings, or secret keys.';
comment on table public.anglow_knowledge_items is
  'Curated cross-venture knowledge for controlled server-side use by Dovroyn and, later, NARA.';
comment on table public.anglow_consumer_access is
  'Declared Anglow knowledge-sharing intent. Application code must require an approved or active status.';
comment on table public.anglow_sync_runs is
  'Audit metadata for future controlled sync jobs. Do not store source payloads or secrets in error_summary or metadata.';

insert into public.anglow_ventures (
  slug, name, aliases, venture_type, lifecycle, description,
  github_repo_url, supabase_project_ref, evidence_status, metadata
) values
  (
    'anglow-digital', 'Anglow Digital Pty Ltd', '{}'::text[], 'parent_company', 'in_development',
    'Parent company and portfolio governance layer.',
    'https://github.com/jaelar78/Anglow-Digital-Website', null, 'confirmed_live',
    '{"role":"portfolio_parent","repository_scope":"company_website"}'::jsonb
  ),
  (
    'dovroyn', 'Dovroyn', array['Meet Millie','Madvora'], 'ai_platform', 'live',
    'Central Anglow intelligence and knowledge hub, kept operationally separate from each venture.',
    'https://github.com/jaelar78/Dovroyn', 'eeapyxahorqwsmamnugn', 'confirmed_live',
    '{"role":"central_intelligence_hub","data_boundary":"curated_sync_only"}'::jsonb
  ),
  (
    'nara', 'NARA', array['MIRA'], 'ai_companion', 'planned',
    'Future cross-portfolio AI companion intended to receive a broad approved knowledge view.',
    null, null, 'confirmed_by_owner',
    '{"role":"future_portfolio_companion","activation":"requires_separate_secured_app"}'::jsonb
  ),
  (
    'gidgee-and-co', 'Gidgee & Co', '{}'::text[], 'ecommerce', 'in_development',
    'Separate commerce venture with its own repository and Supabase project.',
    'https://github.com/jaelar78/Gidgeeco', 'mkuunqsvorxcnlwawgth', 'confirmed_live',
    '{"data_boundary":"separate_production_system"}'::jsonb
  ),
  (
    'the-cleaning-hub', 'The Cleaning Hub', '{}'::text[], 'services_platform', 'planned',
    'Anglow portfolio venture; detailed source connections remain to be confirmed.',
    null, null, 'historical_chat', '{}'::jsonb
  ),
  (
    'cheeky-drawers', 'Cheeky Drawers', '{}'::text[], 'ecommerce', 'discovered',
    'Anglow portfolio venture with a confirmed GitHub repository.',
    'https://github.com/jaelar78/cheeky-draws', null, 'confirmed_live',
    '{}'::jsonb
  ),
  (
    'house-of-mgnm', 'House Of MGNM', '{}'::text[], 'brand', 'planned',
    'Anglow portfolio venture; detailed source connections remain to be confirmed.',
    null, null, 'historical_chat', '{}'::jsonb
  ),
  (
    'luxara-fine-jewellery', 'Luxara Fine Jewellery', '{}'::text[], 'ecommerce', 'planned',
    'Anglow portfolio venture; detailed source connections remain to be confirmed.',
    null, null, 'historical_chat', '{}'::jsonb
  ),
  (
    'waymark-and-co', 'Waymark & Co', '{}'::text[], 'brand', 'discovered',
    'Anglow portfolio venture with a confirmed GitHub repository.',
    'https://github.com/jaelar78/WaymarkandCo', null, 'confirmed_live',
    '{}'::jsonb
  ),
  (
    'our-kaalak', 'OUR KAALAK', '{}'::text[], 'community', 'planned',
    'Anglow portfolio venture; detailed source connections remain to be confirmed.',
    null, null, 'historical_chat', '{}'::jsonb
  ),
  (
    'the-marie-foundation', 'The Marie Foundation', '{}'::text[], 'foundation', 'planned',
    'Anglow portfolio venture; detailed source connections remain to be confirmed.',
    null, null, 'historical_chat', '{}'::jsonb
  ),
  (
    'aussie-spins', 'Aussie Spins', '{}'::text[], 'media', 'discovered',
    'Anglow portfolio venture with a confirmed GitHub repository.',
    'https://github.com/jaelar78/Aussie-spins', null, 'confirmed_live',
    '{}'::jsonb
  );

update public.anglow_ventures
set parent_venture_id = (
  select id from public.anglow_ventures where slug = 'anglow-digital'
)
where slug <> 'anglow-digital';

insert into public.anglow_data_sources (
  venture_id, source_type, source_ref, display_name,
  access_mode, sync_enabled, sensitivity, metadata
)
select
  v.id, s.source_type, s.source_ref, s.display_name,
  'metadata_only', false, 'internal', s.metadata
from (
  values
    ('anglow-digital', 'github_repository', 'jaelar78/Anglow-Digital-Website', 'Anglow Digital website repository', '{"branch":"main"}'::jsonb),
    ('dovroyn', 'github_repository', 'jaelar78/Dovroyn', 'Dovroyn primary repository', '{"branch":"main","status":"primary"}'::jsonb),
    ('dovroyn', 'github_repository', 'jaelar78/meetmillie', 'Meet Millie historical repository', '{"status":"historical"}'::jsonb),
    ('dovroyn', 'github_repository', 'jaelar78/Meet-Millie-Ai', 'Meet Millie AI historical repository', '{"status":"historical"}'::jsonb),
    ('dovroyn', 'github_repository', 'jaelar78/dovroynmpv1', 'Dovroyn MVP v1 repository', '{"status":"historical"}'::jsonb),
    ('dovroyn', 'github_repository', 'jaelar78/Dovroynmpv2', 'Dovroyn MVP v2 repository', '{"status":"historical"}'::jsonb),
    ('dovroyn', 'supabase_project', 'eeapyxahorqwsmamnugn', 'Dovroyn Supabase project', '{"region":"ap-southeast-2"}'::jsonb),
    ('gidgee-and-co', 'github_repository', 'jaelar78/Gidgeeco', 'Gidgee & Co repository', '{"branch":"main"}'::jsonb),
    ('gidgee-and-co', 'supabase_project', 'mkuunqsvorxcnlwawgth', 'Gidgee & Co Supabase project', '{}'::jsonb),
    ('gidgee-and-co', 'vercel_project', 'gidgeeco', 'Gidgee & Co Vercel project', '{}'::jsonb),
    ('cheeky-drawers', 'github_repository', 'jaelar78/cheeky-draws', 'Cheeky Drawers repository', '{"branch":"main"}'::jsonb),
    ('waymark-and-co', 'github_repository', 'jaelar78/WaymarkandCo', 'Waymark & Co repository', '{"branch":"main"}'::jsonb),
    ('aussie-spins', 'github_repository', 'jaelar78/Aussie-spins', 'Aussie Spins repository', '{"branch":"main"}'::jsonb)
) as s(venture_slug, source_type, source_ref, display_name, metadata)
join public.anglow_ventures v on v.slug = s.venture_slug;

insert into public.anglow_consumer_access (
  consumer_venture_id, source_venture_id, access_status,
  all_categories, max_sensitivity, can_read, can_write,
  purpose, approved_by, approved_at
)
select
  consumer.id,
  source.id,
  'approved',
  true,
  'internal',
  true,
  false,
  'Dovroyn may read curated Anglow knowledge through controlled server-side syncs; raw app databases and secrets remain separate.',
  'portfolio_owner',
  timezone('utc', now())
from public.anglow_ventures consumer
cross join public.anglow_ventures source
where consumer.slug = 'dovroyn';

insert into public.anglow_consumer_access (
  consumer_venture_id, source_venture_id, access_status,
  all_categories, max_sensitivity, can_read, can_write,
  purpose, approved_by, approved_at
)
select
  consumer.id,
  source.id,
  'planned',
  true,
  'confidential',
  true,
  false,
  'NARA is intended to receive a broad approved view after a separate secured NARA application and enforcement layer exist.',
  null,
  null
from public.anglow_ventures consumer
cross join public.anglow_ventures source
where consumer.slug = 'nara';

