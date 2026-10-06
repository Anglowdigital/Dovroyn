function demoArtwork(label, accent, secondary, detail) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
      <defs>
        <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${accent}" />
          <stop offset="1" stop-color="${secondary}" />
        </linearGradient>
      </defs>
      <rect width="1200" height="800" rx="48" fill="url(#background)" />
      <circle cx="995" cy="128" r="210" fill="#fff" opacity=".12" />
      <circle cx="160" cy="720" r="250" fill="#fff" opacity=".09" />
      <rect x="86" y="92" width="1028" height="616" rx="38" fill="#fff" opacity=".82" />
      <text x="600" y="330" text-anchor="middle" fill="#1f2a44" font-family="Georgia,serif" font-size="76" font-weight="700">${label}</text>
      <text x="600" y="410" text-anchor="middle" fill="#48536a" font-family="Arial,sans-serif" font-size="30" letter-spacing="8">${detail}</text>
      <path d="M510 510 C555 430 645 430 690 510 C645 590 555 590 510 510Z" fill="none" stroke="#9caf88" stroke-width="16" />
      <path d="M600 438 V582" stroke="#9caf88" stroke-width="12" stroke-linecap="round" />
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function demoPost(post) {
  return { ...post, characterCount: post.content.length };
}

export const DEMO_WORKSPACE = Object.freeze({
  readOnly: true,
  pod: {
    id: 'demo',
    pod_name: 'Aurora Botanicals Winter Launch',
    brand_name: 'Aurora Botanicals',
    pod_type: 'website',
    source_url: 'https://aurora-botanicals.example',
    target_country: 'Australia',
    status: 'direction_locked',
    source_locked_at: '2026-06-02T08:30:00.000Z',
  },
  sources: [
    {
      id: 'demo-source',
      source_type: 'website',
      source_url: 'https://aurora-botanicals.example',
      label: 'Aurora Botanicals fictional storefront',
      notes: 'Sample site for demonstration only. No real business, account, or customer data is used.',
    },
  ],
  analysis: {
    summary: 'A fictional Australian skincare brand that makes effective winter routines feel calm, clear, and attainable.',
    tone: 'Expert, reassuring, modern luxury',
    audience: 'Time-poor Australian customers aged 24–40 who want visible results without a complicated routine.',
    offer: 'A fictional seasonal barrier-repair bundle supported by education, product proof, and a clear guarantee.',
    opportunity: 'Lead with hydration education, show the two-step ritual, then retarget engaged visitors with the bundle.',
    pillars: ['Visible results', 'Simple rituals', 'Ingredient authority'],
    platforms: ['instagram', 'tiktok', 'facebook', 'email'],
    brand_colours: [
      { name: 'Soft Ivory', hex: '#F5EFE6' },
      { name: 'Sage', hex: '#9CAF88' },
      { name: 'Terracotta', hex: '#C67B5C' },
      { name: 'Deep Navy', hex: '#1F2A44' },
    ],
    geography: ['Australia', 'New Zealand'],
    confidence: 0.92,
    source_captured_at: '2026-06-02T08:30:00.000Z',
    personal_data_detected: false,
    personal_data_categories: [],
    evidence: [
      { finding: 'The sample homepage leads with a two-step winter barrier ritual.', source_reference: 'Homepage hero', confidence: 0.96 },
      { finding: 'The sample product copy consistently favours calm, evidence-led language.', source_reference: 'Product collection', confidence: 0.89 },
    ],
  },
  assets: [
    {
      id: 'demo-logo',
      name: 'aurora-botanicals-logo.svg',
      size: 48200,
      preview: demoArtwork('AURORA', '#f5efe6', '#9caf88', 'BOTANICALS'),
      assetRole: 'logo',
    },
    {
      id: 'demo-brand-photo-one',
      name: 'winter-barrier-serum.svg',
      size: 346000,
      preview: demoArtwork('Barrier Serum', '#d9c6b0', '#9caf88', 'WINTER RITUAL'),
      assetRole: 'brand_photo',
    },
    {
      id: 'demo-brand-photo-two',
      name: 'hydration-cream.svg',
      size: 318000,
      preview: demoArtwork('Hydration Cream', '#f5efe6', '#c67b5c', 'TWO SIMPLE STEPS'),
      assetRole: 'brand_photo',
    },
    {
      id: 'demo-campaign-asset',
      name: 'winter-launch-flatlay.svg',
      size: 412000,
      preview: demoArtwork('Winter Launch', '#1f2a44', '#9caf88', 'CAMPAIGN CREATIVE'),
      assetRole: 'campaign_asset',
    },
  ],
  messages: [
    {
      id: 'demo-welcome',
      role: 'assistant',
      content: 'Sample result: I have analysed the fictional Aurora Botanicals site and organised its winter launch direction.',
    },
    {
      id: 'demo-question',
      role: 'user',
      content: 'Which channels should this sample launch start with?',
    },
    {
      id: 'demo-answer',
      role: 'assistant',
      content: 'Sample answer: Start with Instagram for visual proof, TikTok for the two-step ritual, Facebook for retargeting, and email for the launch sequence.',
    },
  ],
  posts: [
    demoPost({
      id: 'demo-instagram',
      platformKey: 'instagram',
      platformName: 'Instagram',
      content: 'A winter evening ritual, made beautifully simple. Restore hydration and support your skin barrier in two calm steps. Save the ritual, then explore the sample winter bundle. #WinterSkin #SkinBarrier #HydrationRitual',
      contentStyle: 'Visual caption',
      status: 'Sample draft',
    }),
    demoPost({
      id: 'demo-tiktok',
      platformKey: 'tiktok',
      platformName: 'TikTok',
      content: 'POV: your winter routine has five products but still misses the barrier-support step that matters most. Here is the fictional two-step reset. #WinterSkin #SkincareRoutine',
      contentStyle: 'Short-form video hook',
      status: 'Sample draft',
    }),
    demoPost({
      id: 'demo-facebook',
      platformKey: 'facebook',
      platformName: 'Facebook',
      content: 'Cold weather can leave a good routine working harder than it should. This sample winter bundle pairs two straightforward hydration steps for calmer evening care.',
      contentStyle: 'Community post',
      status: 'Sample draft',
    }),
    demoPost({
      id: 'demo-email',
      platformKey: 'email',
      platformName: 'Email',
      content: 'Subject: Your two-step winter barrier ritual\n\nA thoughtful winter routine does not need to be complicated. This sample campaign pairs the evening hydration steps in one simple bundle.',
      contentStyle: 'Email campaign',
      status: 'Sample draft',
    }),
  ],
  directionApproved: true,
  calendarCreated: true,
  campaignState: 'Approved',
  observancesEnabled: false,
  budgetDecision: 'approved',
  competitors: [
    {
      name: 'Juniper Rituals',
      sourceUrl: 'https://juniper-rituals.example',
      sourceReference: 'Fictional homepage hero',
      observation: 'This fictional competitor leads with a longer evening ritual. Aurora’s sample direction focuses on two straightforward steps.',
    },
    {
      name: 'Coastal Botanical',
      sourceUrl: 'https://coastal-botanical.example',
      sourceReference: 'Fictional collection page',
      observation: 'This fictional competitor groups products by ingredient. Aurora’s sample opportunity is to explain the seasonal routine first.',
    },
  ],
  competitorWatch: [
    { fictional: true, name: 'Juniper Rituals', sourceUrl: 'https://juniper-rituals.example', checkedAt: '2026-06-03T09:00:00.000Z', positioning: 'Fictional sample: an extended evening ritual.', publicStrengths: ['Sample step-by-step routine pages'], publicGaps: ['Sample routine needs a quicker introduction'], sourceReference: 'Fictional homepage hero' },
    { fictional: true, name: 'Coastal Botanical', sourceUrl: 'https://coastal-botanical.example', checkedAt: '2026-06-03T09:00:00.000Z', positioning: 'Fictional sample: ingredient-led collections.', publicStrengths: ['Sample ingredient navigation'], publicGaps: ['Sample seasonal routine guidance is limited'], sourceReference: 'Fictional collection page' },
  ],
  learningHistory: [
    { fictional: true, at: '2026-06-02T08:30:00.000Z', title: 'Sample source captured', detail: 'The fictional website and prepared brand assets define this sample’s evidence.' },
    { fictional: true, at: '2026-06-02T09:00:00.000Z', title: 'Sample direction approved', detail: 'The fictional owner chose calm, reassuring language and a simple winter ritual.' },
    { fictional: true, at: '2026-06-03T10:00:00.000Z', title: 'Sample drafts reviewed', detail: 'Four prepared channel drafts follow that sample direction. Nothing was published.' },
  ],
});

export const DEMO_TAB_IDS = Object.freeze([
  'sources', 'direction', 'overview', 'assistant', 'assets', 'socials',
  'content', 'calendar', 'campaigns', 'analytics', 'team', 'launch', 'budget',
  'competitors', 'learning',
]);

export function getNextDemoTab(activeTab, key) {
  const index = DEMO_TAB_IDS.indexOf(activeTab);
  if (key === 'Home') return DEMO_TAB_IDS[0];
  if (key === 'End') return DEMO_TAB_IDS[DEMO_TAB_IDS.length - 1];
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[key];
  if (!step || index < 0) return null;
  return DEMO_TAB_IDS[(index + step + DEMO_TAB_IDS.length) % DEMO_TAB_IDS.length];
}

export function canMutatePod(demo) {
  return !demo;
}
