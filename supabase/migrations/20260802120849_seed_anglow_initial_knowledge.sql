
    insert into public.anglow_knowledge_items (
      venture_id, category, title, summary, content,
      sensitivity, share_with_dovroyn, share_with_nara, source_observed_at
    )
    select
      v.id,
      k.category,
      k.title,
      k.summary,
      k.content,
      'internal',
      true,
      true,
      timezone('utc', now())
    from (
      values
        (
          'anglow-digital',
          'architecture',
          'Anglow portfolio data architecture',
          'Anglow Digital is the parent. Each venture keeps its own repository, Supabase project, hosting, credentials, runtime, and production state. Dovroyn receives curated knowledge through controlled server-side syncs; NARA is the planned broad portfolio consumer.',
          jsonb_build_object(
            'parent_company', 'anglow-digital',
            'central_hub', 'dovroyn',
            'future_consumer', 'nara',
            'operational_isolation', true,
            'raw_database_merges', false,
            'share_production_credentials', false,
            'sync_pattern', 'approved_curated_server_side'
          )
        ),
        (
          'anglow-digital',
          'portfolio',
          'Confirmed Anglow venture registry',
          'The currently confirmed portfolio contains eleven ventures under Anglow Digital.',
          jsonb_build_object(
            'venture_slugs',
            jsonb_build_array(
              'dovroyn',
              'nara',
              'gidgee-and-co',
              'the-cleaning-hub',
              'cheeky-drawers',
              'house-of-mgnm',
              'luxara-fine-jewellery',
              'waymark-and-co',
              'our-kaalak',
              'the-marie-foundation',
              'aussie-spins'
            ),
            'status', 'confirmed_from_owner_and_live_account_inventory'
          )
        ),
        (
          'anglow-digital',
          'planning',
          'Historical portfolio sequencing',
          'Earlier planning grouped Gidgee, Luxara, and Cheeky as near-term revenue; Dovroyn, The Cleaning Hub, and NARA as scale plays; and The Marie Foundation, OUR KAALAK, House Of MGNM, and Waymark as legacy or purpose ventures. This remains a historical planning note until reconfirmed.',
          jsonb_build_object(
            'revenue_now', jsonb_build_array('gidgee-and-co', 'luxara-fine-jewellery', 'cheeky-drawers'),
            'scale', jsonb_build_array('dovroyn', 'the-cleaning-hub', 'nara'),
            'legacy_or_purpose', jsonb_build_array('the-marie-foundation', 'our-kaalak', 'house-of-mgnm', 'waymark-and-co'),
            'aussie_spins_group', 'not_confirmed',
            'review_status', 'historical_needs_owner_reconfirmation'
          )
        ),
        (
          'dovroyn',
          'product_role',
          'Dovroyn central hub role',
          'Dovroyn is the Anglow intelligence and curated knowledge hub. It does not own the raw production database, credentials, or runtime of each separate venture.',
          jsonb_build_object(
            'aliases', jsonb_build_array('Meet Millie', 'Madvora'),
            'may_read_curated_portfolio_knowledge', true,
            'may_write_to_venture_production_by_default', false,
            'max_approved_sensitivity', 'internal'
          )
        ),
        (
          'nara',
          'product_role',
          'NARA future portfolio role',
          'NARA is intended to receive the broad approved view across Anglow ventures after NARA exists as a separately secured application with an enforcement layer.',
          jsonb_build_object(
            'alias', 'MIRA',
            'intended_scope', 'broad_approved_portfolio_knowledge',
            'current_status', 'planned',
            'automatic_activation', false,
            'production_secrets_in_scope', false
          )
        ),
        (
          'gidgee-and-co',
          'data_boundary',
          'Gidgee operational separation',
          'Gidgee & Co remains a separate application with its own GitHub repository, Supabase project, Vercel project, credentials, and runtime. Only approved knowledge summaries flow to Dovroyn.',
          jsonb_build_object(
            'github_repository', 'jaelar78/Gidgeeco',
            'supabase_project_ref', 'mkuunqsvorxcnlwawgth',
            'vercel_project', 'gidgeeco',
            'raw_files_in_dovroyn', false,
            'shared_credentials', false
          )
        )
    ) as k(venture_slug, category, title, summary, content)
    join public.anglow_ventures v on v.slug = k.venture_slug;
  

