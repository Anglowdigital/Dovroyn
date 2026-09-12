import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  BarChart3,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  CircleDollarSign,
  Command,
  FileImage,
  Globe2,
  LockKeyhole,
  Mail,
  Megaphone,
  MessageSquareText,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Upload,
  Users,
} from 'lucide-react';
import { supabase, supabaseConfigured } from '../lib/supabaseClient';
import { formatPlatformPost } from '../lib/podEngine';
import { getPlan } from '../lib/plans';
import { getPlatform } from '../lib/platforms';
import { MAX_BRAND_PHOTOS, POD_SOURCE_TYPES, sourceNeedsUrl, validatePodSetup } from '../lib/podSetup';
import { askDemoPodAssistant, askPodAssistant, requestPodAnalysis, requestSocialContent } from '../lib/aiClient';
import {
  getAssetPreview,
  loadPodWorkspace,
  savePodPrimarySource,
  savePodPreference,
  saveSocialPosts,
  uploadPodAsset,
} from '../lib/podRepository';
import PodCommandPalette from '../components/pod/PodCommandPalette';
import PodModal from '../components/pod/PodModal';
import './pod-workspace.css';

const TAB_GROUPS = [
  {
    label: 'Your pod',
    items: [
      ['setup', 'Setup', Settings2],
      ['photos', 'Photo gallery', FileImage],
      ['posts', 'Posts', Sparkles],
      ['calendar', 'Calendar', CalendarDays],
      ['assistant', 'Pod AI', Bot],
    ],
  },
  {
    label: 'More',
    items: [
      ['socials', 'Social accounts', MessageSquareText],
      ['campaigns', 'Campaigns', Megaphone],
      ['analytics', 'Analytics', BarChart3],
      ['team', 'Collaborations', Users],
      ['launch', 'Coming soon', Mail],
      ['budget', 'Budget & ads', CircleDollarSign],
    ],
  },
];

const DEMO_POD = {
  id: 'demo',
  pod_name: 'Aurora Skincare Launch',
  brand_name: 'Aurora Skincare',
  pod_type: 'website',
  source_url: 'https://auroraskincare.co',
  target_country: 'Australia',
  status: 'active',
};

const INITIAL_ANALYSIS = {
  summary: 'A premium skincare brand that makes effective routines feel calm, clear, and attainable.',
  tone: 'Expert, reassuring, modern luxury',
  audience: 'Time-poor customers aged 24–40 who want visible results without a complicated routine.',
  offer: 'A seasonal barrier-repair bundle supported by education, proof, and a confident guarantee.',
  opportunity: 'Lead with hydration and barrier education, then retarget engaged visitors with the bundle.',
  pillars: ['Visible results', 'Simple rituals', 'Ingredient authority'],
  platforms: ['instagram', 'tiktok', 'facebook', 'email'],
};

const CONTENT_SEED = {
  body: 'Cold weather asks more of your skin. Meet the simple evening ritual designed to restore hydration without adding five extra steps.',
  keywords: ['Winter Skin', 'Skin Barrier', 'Aurora Skincare', 'Hydration Ritual'],
  callToAction: 'Explore the winter barrier bundle.',
};

const DEMO_CONTENT_SEEDS = {
  instagram: {
    body: 'A winter evening ritual, made beautifully simple. Restore hydration and support your skin barrier in two calm steps.',
    keywords: ['Winter Skin', 'Skin Barrier', 'Aurora Skincare', 'Hydration Ritual'],
    callToAction: 'Save this ritual, then explore the winter barrier bundle.',
  },
  tiktok: {
    body: 'POV: your winter routine has five products but still misses the barrier-support step that matters most. Here is the two-step reset.',
    keywords: ['Winter Skin', 'Skin Barrier', 'Skincare Routine', 'Hydration'],
    callToAction: 'Watch the routine, then see what is inside the bundle.',
  },
  facebook: {
    body: 'Cold weather can leave a good routine working harder than it should. Our winter barrier bundle pairs two straightforward hydration steps for calmer evening care.',
    keywords: [],
    callToAction: 'Read the routine and decide whether it fits your skin.',
  },
  email: {
    body: 'Subject: Your two-step winter barrier ritual\n\nA thoughtful winter routine does not need to be complicated. We paired the evening hydration steps in one simple bundle.',
    keywords: [],
    callToAction: 'Explore the winter barrier bundle.',
  },
};

const svgPhoto = (from, to, label) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><circle cx="320" cy="290" r="105" fill="rgba(255,255,255,0.26)"/><circle cx="320" cy="290" r="70" fill="rgba(255,255,255,0.22)"/><text x="320" y="555" font-family="Georgia, serif" font-size="34" fill="rgba(255,255,255,0.88)" text-anchor="middle">${label}</text></svg>`)}`;

const DEMO_ASSETS = [
  { id: 'demo-logo', name: 'aurora-logo.svg', size: 48210, preview: svgPhoto('#0a1f3c', '#b88a32', 'Aurora'), assetRole: 'logo' },
  { id: 'demo-photo-1', name: 'barrier-cream.jpg', size: 182340, preview: svgPhoto('#d8b867', '#b88a32', 'Barrier Cream'), assetRole: 'brand_photo' },
  { id: 'demo-photo-2', name: 'night-serum.jpg', size: 164020, preview: svgPhoto('#10294c', '#3f6ea5', 'Night Serum'), assetRole: 'brand_photo' },
  { id: 'demo-photo-3', name: 'hydration-duo.jpg', size: 201540, preview: svgPhoto('#caa26b', '#7c5a2e', 'Hydration Duo'), assetRole: 'brand_photo' },
  { id: 'demo-photo-4', name: 'winter-ritual.jpg', size: 173880, preview: svgPhoto('#e8dcc4', '#a5834a', 'Winter Ritual'), assetRole: 'brand_photo' },
];

const demoPhotos = () => DEMO_ASSETS.filter((asset) => asset.assetRole === 'brand_photo');

const buildDemoPosts = () => INITIAL_ANALYSIS.platforms.map((platformKey, index) => ({
  id: `${platformKey}-demo-${index}`,
  status: 'Draft',
  image: demoPhotos()[index % demoPhotos().length].preview,
  ...formatPlatformPost({ platformKey, ...(DEMO_CONTENT_SEEDS[platformKey] || CONTENT_SEED) }),
}));

function StatusPill({ children, tone = 'gold' }) {
  return <span className={`pod-status pod-status-${tone}`}>{children}</span>;
}

function MetricCard({ label, value, detail, children }) {
  return (
    <article className="pod-metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
      {children}
    </article>
  );
}

function EmptyState({ icon: Icon, title, body, action, actionLabel }) {
  return (
    <div className="pod-empty-state">
      <span><Icon size={22} /></span>
      <h3>{title}</h3>
      <p className="subtle">{body}</p>
      {action && <button className="button button-primary button-sm" type="button" onClick={action}>{actionLabel}</button>}
    </div>
  );
}

export default function PodWorkspace({ demo = false, session, subscription }) {
  const { podId } = useParams();
  const [pod, setPod] = useState(demo ? DEMO_POD : null);
  const [loading, setLoading] = useState(!demo);
  const [activeTab, setActiveTab] = useState('setup');
  const [analysis, setAnalysis] = useState(demo ? INITIAL_ANALYSIS : null);
  const [analysisState, setAnalysisState] = useState(demo ? 'ready' : 'idle');
  const [aiMessages, setAiMessages] = useState(demo ? [{ id: 'demo-welcome', role: 'assistant', content: 'I am the private AI for this Aurora pod. Ask me about this brand, its photos, campaigns or the posts I create.' }] : []);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiSending, setAiSending] = useState(false);
  const [toneTweak, setToneTweak] = useState('');
  const [sources, setSources] = useState([]);
  const [sourceType, setSourceType] = useState('website');
  const [sourceUrl, setSourceUrl] = useState(demo ? DEMO_POD.source_url : '');
  const [assets, setAssets] = useState(demo ? DEMO_ASSETS : []);
  const [posts, setPosts] = useState(demo ? buildDemoPosts() : []);
  const [calendarCreated, setCalendarCreated] = useState(false);
  const [campaignState, setCampaignState] = useState('Draft');
  const [observancesEnabled, setObservancesEnabled] = useState(false);
  const [budgetDecision, setBudgetDecision] = useState('pending');
  const [modal, setModal] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const plan = getPlan(subscription?.tier || (demo ? 'growth' : 'free'));
  const sourceLocked = Boolean(pod?.source_locked_at || analysis);
  const logoAssets = assets.filter((asset) => asset.assetRole === 'logo');
  const brandPhotos = assets.filter((asset) => asset.assetRole === 'brand_photo');
  const galleryAssets = assets.filter((asset) => ['logo', 'brand_photo', 'campaign_asset'].includes(asset.assetRole));
  const selectedSource = POD_SOURCE_TYPES.find((source) => source.value === sourceType);

  useEffect(() => {
    if (demo || !supabaseConfigured || !podId) {
      setLoading(false);
      return;
    }

    let mounted = true;
    loadPodWorkspace(podId).then(async (workspace) => {
      if (!mounted) return;
      setPod(workspace.pod || null);
      setSourceType(workspace.pod?.source_type || (workspace.pod?.source_url ? 'website' : 'photos'));
      setSourceUrl(workspace.pod?.source_url || '');
      setSources(workspace.sources || []);
      setAiMessages(workspace.messages || []);
      if (workspace.analysis) {
        let platformKeys = [];
        let pillars = [];
        try { platformKeys = JSON.parse(workspace.analysis.social_recommendations || '[]'); } catch { platformKeys = []; }
        try { pillars = JSON.parse(workspace.analysis.content_ideas || '[]'); } catch { pillars = []; }
        setAnalysis({
          summary: workspace.analysis.brand_summary,
          tone: workspace.analysis.tone,
          audience: workspace.analysis.audience,
          offer: workspace.analysis.offer_direction,
          opportunity: workspace.analysis.campaign_angles,
          platforms: platformKeys.length ? platformKeys : INITIAL_ANALYSIS.platforms,
          pillars: pillars.length ? pillars : INITIAL_ANALYSIS.pillars,
        });
        setAnalysisState('ready');
      }
      if (workspace.posts.length) {
        setPosts(workspace.posts.map((post, index) => {
          const platform = getPlatform(post.platform);
          return {
            id: post.id,
            platformKey: post.platform,
            platformName: platform?.name || post.platform,
            content: post.body,
            characterCount: post.body.length,
            contentStyle: platform?.rules?.contentStyle || 'Platform-specific',
            status: post.status,
            image: '',
            imageIndex: index,
          };
        }));
      }
      if (workspace.assets.length) {
        const persistedAssets = await Promise.all(workspace.assets.map(async (asset) => ({
          id: asset.id,
          name: asset.file_name,
          size: asset.file_size,
          preview: await getAssetPreview(asset.storage_path).catch(() => ''),
          storagePath: asset.storage_path,
          assetRole: asset.asset_role || 'campaign_asset',
        })));
        if (mounted) setAssets(persistedAssets);
      }
      setLoading(false);
    }).catch(() => {
      if (mounted) { setPod(null); setLoading(false); }
    });
    return () => { mounted = false; };
  }, [demo, podId]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const allTabs = useMemo(() => TAB_GROUPS.flatMap((group) => group.items), []);
  const commands = useMemo(() => [
    ...allTabs.map(([key, label]) => ({ group: 'Open tab', label, action: () => setActiveTab(key) })),
    { group: 'Pod action', label: analysis ? 'Re-run brand analysis' : 'Teach the pod my brand', action: () => { setActiveTab('setup'); if (!analysis) window.setTimeout(() => runAnalysis(), 0); } },
    { group: 'Pod action', label: 'Ask this pod AI', action: () => setActiveTab('assistant') },
    { group: 'Pod action', label: 'Add photos to the gallery', action: () => setActiveTab('photos') },
    { group: 'Pod action', label: 'Create posts from my photos', action: () => { setActiveTab('posts'); window.setTimeout(() => generateContent(), 0); } },
  ], [allTabs, analysis, sourceLocked]);

  const showNotice = (message) => setNotice(message);

  const savePrimarySource = async (event) => {
    event.preventDefault();
    if (sourceLocked) {
      showNotice('This pod source is locked. Create another pod for a different source.');
      return;
    }
    if (sourceNeedsUrl(sourceType) && !sourceUrl.trim()) {
      showNotice('Add the one primary URL for this pod.');
      return;
    }
    if (demo || !pod?.id) return;
    try {
      const savedPod = await savePodPrimarySource(pod.id, { sourceType, sourceUrl });
      setPod(savedPod);
      setSources((current) => [
        ...current.filter((source) => !['website', 'social', 'shopify'].includes(source.source_type)),
        ...(sourceUrl.trim() ? [{ id: `primary-${pod.id}`, source_type: sourceType, source_url: sourceUrl.trim(), label: sourceUrl.trim() }] : []),
      ]);
      showNotice('Primary source saved. It will lock after analysis.');
    } catch (error) {
      showNotice(error.message || 'The primary source could not be saved.');
    }
  };

  const addAssets = async (event, assetRole) => {
    if (sourceLocked && ['logo', 'brand_photo'].includes(assetRole)) {
      showNotice('Brand-analysis images are locked for this pod.');
      event.target.value = '';
      return;
    }
    let files = Array.from(event.target.files || []);
    if (assetRole === 'logo') {
      if (logoAssets.length || files.length !== 1) {
        showNotice('Each pod can have one logo.');
        event.target.value = '';
        return;
      }
      files = files.slice(0, 1);
    }
    if (assetRole === 'brand_photo') {
      const remaining = MAX_BRAND_PHOTOS - brandPhotos.length;
      if (files.length > remaining) {
        showNotice(`You can add ${remaining} more brand photo${remaining === 1 ? '' : 's'} to this pod.`);
        event.target.value = '';
        return;
      }
    }
    const nextAssets = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      preview: URL.createObjectURL(file),
      assetRole,
    }));
    setAssets((current) => [...current, ...nextAssets]);
    if (nextAssets.length) showNotice(`${nextAssets.length} photo${nextAssets.length === 1 ? '' : 's'} added to your gallery.`);
    event.target.value = '';
    if (!demo && pod?.id && session?.user?.id) {
      try {
        const savedAssets = await Promise.all(files.map(async (file) => {
          const saved = await uploadPodAsset({ userId: session.user.id, podId: pod.id, file, assetRole });
          return {
            id: saved.id,
            name: saved.file_name,
            size: saved.file_size,
            storagePath: saved.storage_path,
            preview: await getAssetPreview(saved.storage_path),
            assetRole: saved.asset_role,
          };
        }));
        const replacements = new Map(nextAssets.map((asset, index) => [asset.id, savedAssets[index]]));
        setAssets((current) => current.map((asset) => replacements.get(asset.id) || asset));
        showNotice(`${savedAssets.length} photo${savedAssets.length === 1 ? '' : 's'} saved to private pod storage.`);
      } catch (error) {
        setAssets((current) => current.filter((asset) => !nextAssets.some((optimistic) => optimistic.id === asset.id)));
        nextAssets.forEach((asset) => URL.revokeObjectURL(asset.preview));
        showNotice(error.message || 'The private image upload could not be saved.');
      }
    }
  };

  const runAnalysis = async () => {
    if (sourceLocked) {
      showNotice('This pod has already learned this brand. Tweak the tone below to adjust it.');
      return;
    }
    const setupError = demo ? '' : validatePodSetup({
      sourceType,
      sourceUrl,
      logoCount: logoAssets.length,
      photoCount: brandPhotos.length,
    });
    if (setupError) {
      setModal({ type: 'missing-source', message: setupError });
      return;
    }
    setAnalysisState('running');
    try {
      let nextAnalysis = INITIAL_ANALYSIS;
      if (demo) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      } else {
        const accessToken = session?.access_token;
        if (!accessToken) throw new Error('Sign in again before running analysis.');
        const savedPod = sourceLocked ? pod : await savePodPrimarySource(pod.id, { sourceType, sourceUrl });
        setPod(savedPod);
        const result = await requestPodAnalysis({
          accessToken,
          podId: pod.id,
          notes: sources.map((source) => source.notes).filter(Boolean).join('\n').slice(0, 4000),
          imageUrls: [...logoAssets, ...brandPhotos].map((asset) => asset.preview).filter((url) => /^https:\/\//i.test(url)),
        });
        nextAnalysis = result.analysis;
        setPod((current) => ({ ...current, source_locked_at: result.sourceLockedAt || new Date().toISOString(), status: 'direction_locked' }));
        if (supabaseConfigured && pod?.id) {
          await supabase.from('pods').update({
            status: 'direction_locked',
            accepted_tone: nextAnalysis?.tone,
            accepted_strategy: nextAnalysis?.opportunity,
            updated_at: new Date().toISOString(),
          }).eq('id', pod.id);
        }
      }
      setAnalysis(nextAnalysis);
      setAnalysisState('ready');
      showNotice('Your pod has learned this brand. You can create posts now.');
    } catch (error) {
      setAnalysisState('idle');
      showNotice(error.message || 'AI analysis could not run. Check the server configuration.');
    }
  };

  const saveToneTweak = async () => {
    if (!toneTweak.trim()) return;
    setAnalysis((current) => ({ ...current, tone: toneTweak.trim(), userDirection: toneTweak.trim() }));
    if (!demo && pod?.id) {
      try { await savePodPreference(pod.id, 'brand_direction', toneTweak.trim()); } catch { showNotice('Tone applied in this session; the workspace migration is needed to save it.'); setToneTweak(''); return; }
    }
    setToneTweak('');
    showNotice('Tone updated. Future posts will use it.');
  };

  const generateContent = async () => {
    if (!analysis) {
      setModal({ type: 'analysis-first' });
      return;
    }
    try {
      let generated;
      if (demo) {
        generated = buildDemoPosts();
      } else {
        if (!session?.access_token) throw new Error('Sign in again before generating content.');
        const result = await requestSocialContent({
          accessToken: session.access_token,
          podId: pod.id,
          platforms: analysis.platforms,
          contentDay: new Date().toISOString().slice(0, 10),
        });
        generated = result.posts.map((post, index) => ({ ...post, id: `${post.platformKey}-${Date.now()}-${index}`, status: 'Draft' }));
      }
      const photoPool = brandPhotos.map((asset) => asset.preview).filter(Boolean);
      generated = generated.map((post, index) => ({
        ...post,
        image: photoPool.length ? photoPool[index % photoPool.length] : post.image || '',
      }));
      setPosts(generated);
      if (!demo && pod?.id) {
        const saved = await saveSocialPosts(pod.id, generated);
        setPosts((current) => current.map((post, index) => ({ ...post, id: saved[index]?.id || post.id })));
      }
      setActiveTab('posts');
      showNotice(`${generated.length} posts created with your gallery photos.`);
    } catch (error) {
      showNotice(error.message || 'Content generation could not run.');
    }
  };

  const createCalendar = () => {
    if (!posts.length) {
      setModal({ type: 'content-first' });
      return;
    }
    setCalendarCreated(true);
    showNotice(`Calendar generated inside the current allowance of ${plan.monthlyContentDays} content days.`);
  };

  const askPodAi = async (event) => {
    event.preventDefault();
    const question = aiQuestion.trim();
    if (!question || aiSending) return;
    const userMessage = { id: crypto.randomUUID(), role: 'user', content: question };
    setAiMessages((current) => [...current, userMessage]);
    setAiQuestion('');
    setAiSending(true);
    try {
      let answer;
      let memorySaved = true;
      if (demo) {
        answer = await askDemoPodAssistant(question);
      } else {
        if (!session?.access_token) throw new Error('Sign in again before using this pod AI.');
        const result = await askPodAssistant({ accessToken: session.access_token, podId: pod.id, question });
        answer = result.answer;
        memorySaved = result.memorySaved;
      }
      setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: answer }]);
      if (!memorySaved) showNotice('The answer is visible, but pod memory needs the workspace migration before it can be saved.');
    } catch (error) {
      showNotice(error.message || 'This pod AI could not answer right now.');
    } finally {
      setAiSending(false);
    }
  };

  if (loading) return <div className="pod-workspace-loading">Opening this pod…</div>;
  if (!pod) return <EmptyState icon={BriefcaseBusiness} title="Pod not found" body="This pod is unavailable or does not belong to the signed-in account." />;

  const renderPanel = () => {
    switch (activeTab) {
      case 'setup':
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading">
              <div>
                <p className="eyebrow">Step 1 · Start here</p>
                <h2>Pod setup</h2>
                <p className="subtle">Give the pod your website, your logo and a few product photos. It learns your brand from these and uses the photos when it creates your posts.</p>
              </div>
              {sourceLocked && <StatusPill tone="green">Brand learned</StatusPill>}
            </header>
            {sourceLocked ? (
              <article className="pod-lock-card"><LockKeyhole size={22} /><div><strong>This pod knows your brand.</strong><p>Your website and photos are locked in so every post stays on-brand. Create another pod for a different business.</p></div></article>
            ) : (
              <>
                <form className="pod-source-form pod-primary-source-form" onSubmit={savePrimarySource}>
                  <label>Primary source type
                    <select value={sourceType} onChange={(event) => { setSourceType(event.target.value); if (event.target.value === 'photos') setSourceUrl(''); }}>
                      {POD_SOURCE_TYPES.map((source) => <option value={source.value} key={source.value}>{source.label}</option>)}
                    </select>
                  </label>
                  {sourceNeedsUrl(sourceType) && <label>One primary {selectedSource?.label.toLowerCase()} URL<input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder={selectedSource?.placeholder} required /></label>}
                  <button className="button button-ghost" type="submit">Save source</button>
                </form>
                <div className="pod-brand-upload-grid">
                  <label className="pod-upload-zone">
                    <Upload size={24} />
                    <strong>{logoAssets.length ? 'Logo added' : 'Add your logo'}</strong>
                    <span>PNG, JPG, or WebP. One logo per pod.</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" disabled={logoAssets.length >= 1} onChange={(event) => addAssets(event, 'logo')} />
                  </label>
                  <label className="pod-upload-zone">
                    <Upload size={24} />
                    <strong>Add up to {MAX_BRAND_PHOTOS} brand or product photos</strong>
                    <span>{brandPhotos.length}/{MAX_BRAND_PHOTOS} added. The pod uses these in your posts.</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={brandPhotos.length >= MAX_BRAND_PHOTOS} onChange={(event) => addAssets(event, 'brand_photo')} />
                  </label>
                </div>
                <div className="pod-analysis-lock-action"><div><strong>Ready?</strong><p>The pod reads your website and photos, learns your brand, and locks these inputs to this pod.</p></div><button className="button button-primary" type="button" onClick={runAnalysis} disabled={analysisState === 'running'}><Sparkles size={16} /> {analysisState === 'running' ? 'Learning your brand…' : 'Teach the pod my brand'}</button></div>
              </>
            )}
            {analysis && (
              <>
                <section>
                  <p className="eyebrow">Step 2 · What the pod learned</p>
                  <div className="pod-insight-grid">
                    {[['Brand summary', analysis.summary], ['Tone', analysis.tone], ['Audience', analysis.audience], ['Offer', analysis.offer], ['Strongest opportunity', analysis.opportunity]].map(([label, value]) => <article key={label}><small>{label}</small><p>{value}</p></article>)}
                  </div>
                </section>
                <article className="pod-rich-card"><small>Content pillars</small><div className="pod-chip-row">{analysis.pillars.map((pillar) => <span key={pillar}>{pillar}</span>)}</div></article>
                <article className="pod-rich-card pod-tone-edit">
                  <small>Not quite right? Tweak the tone</small>
                  <div className="pod-tone-edit-row">
                    <input type="text" value={toneTweak} onChange={(event) => setToneTweak(event.target.value)} placeholder="For example: more casual, less luxury…" maxLength={280} />
                    <button className="button button-ghost button-sm" type="button" disabled={!toneTweak.trim()} onClick={saveToneTweak}>Update tone</button>
                  </div>
                </article>
                <div className="pod-action-row">
                  <button className="button button-primary" type="button" onClick={generateContent}><Sparkles size={16} /> Create posts from my photos</button>
                  <button className="button button-ghost" type="button" onClick={() => setActiveTab('photos')}><FileImage size={16} /> Open photo gallery</button>
                </div>
              </>
            )}
          </div>
        );
      case 'photos':
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading">
              <div>
                <p className="eyebrow">Your gallery</p>
                <h2>Photo gallery</h2>
                <p className="subtle">These are the photos the pod AI uses when it creates your posts. Add more any time — better photos make better posts.</p>
              </div>
              <StatusPill>{galleryAssets.length} photo{galleryAssets.length === 1 ? '' : 's'}</StatusPill>
            </header>
            {!sourceLocked && (
              <label className="pod-upload-zone">
                <Upload size={24} />
                <strong>Add more photos</strong>
                <span>{brandPhotos.length}/{MAX_BRAND_PHOTOS} brand photos added. PNG, JPG, or WebP.</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={brandPhotos.length >= MAX_BRAND_PHOTOS} onChange={(event) => addAssets(event, 'brand_photo')} />
              </label>
            )}
            {sourceLocked && (
              <label className="pod-upload-zone">
                <Upload size={24} />
                <strong>Add campaign photos</strong>
                <span>Extra working photos for new posts. Your locked brand photos stay untouched.</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => addAssets(event, 'campaign_asset')} />
              </label>
            )}
            {galleryAssets.length ? (
              <div className="pod-gallery-grid">
                {galleryAssets.map((asset) => (
                  <article key={asset.id}>
                    <img src={asset.preview} alt={asset.name} />
                    <div><strong>{asset.name}</strong><small>{asset.assetRole === 'logo' ? 'Logo' : asset.assetRole === 'brand_photo' ? 'Brand photo' : 'Campaign photo'}</small></div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState icon={FileImage} title="No photos yet" body="Add your logo and product photos in Setup, and they will appear here." action={() => setActiveTab('setup')} actionLabel="Go to setup" />
            )}
            <div className="pod-action-row">
              <button className="button button-primary" type="button" onClick={generateContent}><Sparkles size={16} /> Create posts from these photos</button>
            </div>
          </div>
        );
      case 'posts':
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading">
              <div>
                <p className="eyebrow">Made for you</p>
                <h2>Your posts</h2>
                <p className="subtle">Each post pairs one of your gallery photos with a caption written for that platform. Edit any caption before it goes out.</p>
              </div>
              <button className="button button-primary" type="button" onClick={generateContent}><Sparkles size={16} /> Create posts</button>
            </header>
            {posts.length === 0 ? (
              <EmptyState
                icon={MessageSquareText}
                title="No posts yet"
                body={analysis ? 'Create a set of platform-ready posts from your gallery photos.' : 'Finish setup first so the pod knows your brand, then create posts.'}
                action={analysis ? generateContent : () => setActiveTab('setup')}
                actionLabel={analysis ? 'Create posts now' : 'Go to setup'}
              />
            ) : (
              <div className="pod-post-list">
                {posts.map((post) => (
                  <article key={post.id} className="pod-post-card">
                    {post.image && <img className="pod-post-image" src={post.image} alt={`${post.platformName} post visual`} />}
                    <header><div><strong>{post.platformName}</strong><small>{post.characterCount} characters · {post.contentStyle}</small></div><StatusPill>{post.status || 'Draft'}</StatusPill></header>
                    <textarea value={post.content} onChange={(event) => setPosts((current) => current.map((item) => item.id === post.id ? { ...item, content: event.target.value, characterCount: event.target.value.length } : item))} rows={5} />
                    <footer><button className="button button-ghost button-sm" type="button" onClick={() => showNotice(`${post.platformName} post saved in this pod.`)}>Save edit</button><button className="button button-primary button-sm" type="button" onClick={() => { setActiveTab('calendar'); showNotice('Choose a posting day for this post.'); }}>Add to calendar</button></footer>
                  </article>
                ))}
              </div>
            )}
          </div>
        );
      case 'assistant':
        return (
          <div className="pod-panel-stack pod-ai-panel">
            <header className="pod-panel-heading"><div><p className="eyebrow">Private pod intelligence</p><h2>{pod.pod_name} AI</h2><p className="subtle">One Dovroyn AI service, isolated memory for this pod only. It knows this pod's website, photos, tone and your corrections.</p></div><StatusPill tone="green">Pod-isolated</StatusPill></header>
            <div className="pod-ai-thread" aria-live="polite">
              {aiMessages.length === 0 && <div className="pod-ai-welcome"><Bot size={22} /><strong>Ask this pod anything</strong><p>I can explain what the pod learned, refine the tone, plan campaigns or help shape platform-specific posts.</p></div>}
              {aiMessages.map((message) => <article key={message.id || `${message.role}-${message.created_at}`} className={`pod-ai-message pod-ai-message-${message.role}`}><span>{message.role === 'assistant' ? 'Pod AI' : 'You'}</span><p>{message.content}</p></article>)}
              {aiSending && <article className="pod-ai-message pod-ai-message-assistant"><span>Pod AI</span><p>Thinking inside this pod…</p></article>}
            </div>
            <form className="pod-ai-composer" onSubmit={askPodAi}>
              <textarea aria-label="Ask this pod AI" rows={3} value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} placeholder="Ask about this brand, campaign, or post ideas…" maxLength={2000} />
              <button className="button button-primary" type="submit" disabled={!aiQuestion.trim() || aiSending}><Send size={16} /> Ask pod AI</button>
            </form>
            <small className="pod-ai-privacy">This AI cannot publish, connect accounts or spend money without the separate provider connection.</small>
          </div>
        );
      case 'calendar':
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">Current allowance period</p><h2>Content calendar</h2><p className="subtle">Up to {plan.monthlyContentDays} content days per allowance month and {plan.weeklyPostingDays} posting days each week.</p></div><button className="button button-primary" type="button" onClick={createCalendar}><CalendarDays size={16} /> Generate calendar</button></header>
            <label className="pod-toggle"><input type="checkbox" checked={observancesEnabled} onChange={(event) => setObservancesEnabled(event.target.checked)} /><span /><div><strong>Include selected religious observances</strong><small>Off by default. Dovroyn will never guess a user's religion.</small></div></label>
            {calendarCreated ? <div className="pod-calendar-grid">{['Mon 3', 'Wed 5', 'Fri 7', 'Mon 10', 'Thu 13', 'Sat 15'].slice(0, Math.max(2, plan.weeklyPostingDays)).map((day, index) => <article key={day}><small>{day}</small><strong>{posts[index % posts.length]?.platformName || 'Campaign'}</strong><p>{index === 1 ? 'Regional public-holiday angle' : 'Brand campaign post'}</p><StatusPill>{index < 2 ? 'Ready' : 'Draft'}</StatusPill></article>)}</div> : <EmptyState icon={CalendarDays} title="Calendar not generated" body="Create posts first, then the pod can place them within the paid allowance period." />}
          </div>
        );
      case 'socials':
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">Recommended channels</p><h2>Connect social accounts</h2><p className="subtle">Sign in through each official provider. Dovroyn never asks for your social password.</p></div></header>
            <div className="pod-social-grid">
              {(analysis?.platforms || ['instagram', 'facebook', 'tiktok', 'email']).map((key) => { const platform = getPlatform(key); return <article key={key} className="pod-social-card"><span className="pod-social-monogram">{platform.name.slice(0, 2)}</span><div><h3>{platform.name}</h3><p>{platform.focus}</p><small>Planning ready · Provider setup required for live connection</small></div><button className="button button-ghost button-sm" type="button" onClick={() => setModal({ type: 'connect', platform })}>Connect account</button></article>; })}
            </div>
            <p className="pod-honesty-note">Dovroyn can plan for 30+ platforms. Live sign-in and publishing become available one provider at a time after its developer app, permissions, and API review are configured.</p>
          </div>
        );
      case 'campaigns':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Campaigns</p><h2>Winter barrier launch</h2></div><StatusPill>{campaignState}</StatusPill></header><section className="pod-campaign-board">{['Brief', 'Creative', 'Schedule', 'Live'].map((stage, index) => <article key={stage}><small>0{index + 1}</small><h3>{stage}</h3><p>{['Website and photos analysed', 'Platform posts created', 'Waiting for calendar generation', 'Goes out only on connected accounts'][index]}</p><span className={index < (campaignState === 'Live' ? 4 : 2) ? 'complete' : ''} /></article>)}</section><div className="pod-action-row"><button className="button button-primary" type="button" onClick={() => { setCampaignState('Live'); showNotice('Campaign marked ready. Publishing still requires connected accounts.'); }}>Mark ready to publish</button><button className="button button-ghost" type="button" onClick={() => { setCampaignState('Draft'); showNotice('Campaign returned to draft.'); }}>Return to draft</button></div></div>;
      case 'analytics':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Analytics</p><h2>Organic and campaign signals</h2><p className="subtle">Sample layout until connected platforms provide real data.</p></div><StatusPill>Preview data</StatusPill></header><section className="pod-metric-grid"><MetricCard label="Reach" value="18.4K" detail="+12.8% vs prior period" /><MetricCard label="Engagement" value="6.2%" detail="Strongest on Instagram" /><MetricCard label="Clicks" value="1,247" detail="Website visits" /><MetricCard label="Conversions" value="84" detail="Provider attribution required" /></section><article className="pod-rich-card"><div className="pod-card-heading"><div><small>Channel trend</small><h3>Last 8 campaign days</h3></div><BarChart3 /></div><div className="pod-chart pod-chart-large">{[32, 46, 42, 60, 54, 76, 68, 88].map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}</div></article></div>;
      case 'team':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Collaborations</p><h2>People inside this pod</h2><p className="subtle">Invite-only workspace access. Database policies still enforce pod ownership and membership.</p></div><button className="button button-primary button-sm" type="button" onClick={() => setModal({ type: 'invite' })}><Plus size={15} /> Invite collaborator</button></header><article className="pod-team-row"><span>{session?.user?.email?.slice(0, 2).toUpperCase() || 'YO'}</span><div><strong>{session?.user?.email || 'You'}</strong><small>Owner · Full pod access</small></div><StatusPill tone="green">Active</StatusPill></article></div>;
      case 'launch':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Coming soon</p><h2>Launch page and email capture</h2><p className="subtle">Create a simple branded page inside this pod, then check it before publishing.</p></div><button className="button button-primary" type="button" onClick={() => setModal({ type: 'launch' })}><Sparkles size={16} /> Generate page draft</button></header><article className="pod-launch-preview"><span className="pod-launch-orbit"><Sparkles /></span><p className="eyebrow">Aurora Skincare</p><h2>Winter skin, restored.</h2><p>A calmer barrier ritual is almost here. Join the list for first access.</p><div><input aria-label="Preview email" placeholder="you@example.com" disabled /><button type="button" disabled>Notify me</button></div><small>Preview only · Email captures remain private to this pod</small></article></div>;
      case 'budget':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Budget & ads</p><h2>Spend with a safety boundary</h2><p className="subtle">Scale receives the full live-spend view after ad providers are connected. This screen currently uses clearly marked preview data.</p></div><StatusPill>Preview data</StatusPill></header><section className="pod-metric-grid"><MetricCard label="Planned budget" value="$2,000" detail="Monthly plan" /><MetricCard label="Preview spend" value="$847" detail="Provider connection required" /><MetricCard label="Preview revenue" value="$4,230" detail="Attribution required" /><MetricCard label="Preview ROAS" value="4.99x" detail="Not live data" /></section><article className="pod-budget-recommendation"><span><CircleDollarSign /></span><div><small>AI recommendation</small><h3>Move 20% of the test budget toward the stronger Reel creative.</h3><p>No real spend changes unless you say yes and the ad provider is connected.</p></div><div className="pod-action-row"><button className="button button-primary button-sm" type="button" onClick={() => { setBudgetDecision('approved'); showNotice('Recommendation noted for the plan. No live provider change was made.'); }}>Sounds good</button><button className="button button-ghost button-sm" type="button" onClick={() => { setBudgetDecision('rejected'); showNotice('Recommendation dismissed. This pod will remember that preference.'); }}>No thanks</button></div></article>{budgetDecision !== 'pending' && <p className="pod-decision-note">Decision recorded in this session: <strong>{budgetDecision}</strong>.</p>}</div>;
      default:
        return null;
    }
  };

  return (
    <section className="pod-workspace">
      <header className="pod-workspace-topbar">
        <div className="pod-workspace-title"><span className="pod-brand-orb">{logoAssets[0]?.preview ? <img src={logoAssets[0].preview} alt="" /> : <Sparkles size={18} />}</span><div><p className="eyebrow">{pod.brand_name || pod.pod_type}</p><h1>{pod.pod_name}</h1></div></div>
        <div className="pod-workspace-actions"><StatusPill tone={analysis ? 'green' : 'gold'}>{analysis ? 'Brand learned' : 'Setup in progress'}</StatusPill><button className="pod-command-trigger" type="button" onClick={() => setPaletteOpen(true)}><Command size={15} /> Commands <kbd>Ctrl K</kbd></button></div>
      </header>
      <div className="pod-workspace-body">
        <aside className="pod-workspace-nav" aria-label="Pod sections">{TAB_GROUPS.map((group) => <div key={group.label}><p>{group.label}</p>{group.items.map(([key, label, Icon]) => <button key={key} className={activeTab === key ? 'active' : ''} type="button" onClick={() => setActiveTab(key)}><Icon size={16} /><span>{label}</span></button>)}</div>)}</aside>
        <main className="pod-workspace-panel">{renderPanel()}</main>
      </div>
      {notice && <div className="pod-toast" role="status"><Check size={16} />{notice}</div>}
      <PodCommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <PodModal open={modal?.type === 'connect'} title={`Connect ${modal?.platform?.name || 'account'}`} description="Account connection must use the platform's official authorisation screen." onClose={() => setModal(null)}><div className="pod-provider-message"><Globe2 /><div><strong>Provider setup is not live yet</strong><p>Dovroyn can already plan {modal?.platform?.name} content. Live sign-in needs the provider app ID, permissions, redirect URL, token encryption, and platform approval before this button can safely open OAuth.</p></div></div><button className="button button-ghost" type="button" onClick={() => setModal(null)}>Understood</button></PodModal>
      <PodModal open={modal?.type === 'missing-source'} title="Complete the pod setup first" description={modal?.message || 'Add one primary source, one logo, and no more than five brand photos.'} onClose={() => setModal(null)}><button className="button button-primary" type="button" onClick={() => { setModal(null); setActiveTab('setup'); }}>Complete setup</button></PodModal>
      <PodModal open={modal?.type === 'analysis-first'} title="Finish setup first" description="Posts are created from this pod's website and photos, so the pod needs to learn your brand first." onClose={() => setModal(null)}><button className="button button-primary" type="button" onClick={() => { setModal(null); setActiveTab('setup'); }}>Go to setup</button></PodModal>
      <PodModal open={modal?.type === 'content-first'} title="Create posts first" description="The calendar schedules the posts this pod creates for you." onClose={() => setModal(null)}><button className="button button-primary" type="button" onClick={() => { setModal(null); setActiveTab('posts'); }}>Open posts</button></PodModal>
      <PodModal open={modal?.type === 'invite'} title="Invite a collaborator" description="Invitations will be sent only after private pod-membership policies and email delivery are enabled." onClose={() => setModal(null)}><label className="pod-modal-field">Email address<input type="email" placeholder="collaborator@example.com" /></label><button className="button button-primary" type="button" onClick={() => { setModal(null); showNotice('Invite saved as pending setup; no email was sent.'); }}>Save pending invite</button></PodModal>
      <PodModal open={modal?.type === 'launch'} title="Coming-soon draft created" description="The page stays private until publishing infrastructure and its address are configured." onClose={() => setModal(null)}><div className="pod-provider-message"><Mail /><div><strong>Draft ready inside this pod</strong><p>The page uses this pod's brand direction and stores email captures separately from marketing content.</p></div></div><button className="button button-primary" type="button" onClick={() => { setModal(null); showNotice('Coming-soon page draft saved.'); }}>Save page draft</button></PodModal>
    </section>
  );
}
