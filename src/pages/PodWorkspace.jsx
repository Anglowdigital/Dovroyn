import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDollarSign,
  Command,
  FileImage,
  Globe2,
  LayoutDashboard,
  LockKeyhole,
  Mail,
  Megaphone,
  MessageSquareText,
  Palette,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Upload,
  Users,
} from 'lucide-react';
import { supabaseConfigured } from '../lib/supabaseClient';
import { isPodDirectionApprovalCurrent, restorePodDirection } from '../lib/podDirection';
import { buildCalendarItems, restoreOperationalState } from '../lib/podState';
import { getPlan } from '../lib/plans';
import { getPlatform, getPlanningPlatforms } from '../lib/platforms';
import { MAX_BRAND_PHOTOS, POD_SOURCE_TYPES, sourceNeedsUrl, validatePodSetup } from '../lib/podSetup';
import { askPodAssistant, requestPodAnalysis, requestSocialContent } from '../lib/aiClient';
import { canMutatePod, DEMO_WORKSPACE, getNextDemoTab } from '../lib/demoPod';
import {
  approvePodDirection,
  getAssetPreview,
  loadPodWorkspace,
  savePlatformSelection,
  saveCalendarItems,
  saveCampaignDecision,
  saveBudgetPlan,
  savePreferenceDecision,
  saveHolidayPreference,
  saveWebsiteIntelligenceSnapshot,
  savePodDirectionOverride,
  savePodPrimarySource,
  saveSocialPosts,
  updateSocialPost,
  uploadPodAsset,
} from '../lib/podRepository';
import PodCommandPalette from '../components/pod/PodCommandPalette';
import PodModal from '../components/pod/PodModal';
import './pod-workspace.css';

const TAB_GROUPS = [
  {
    label: 'Pod brain',
    items: [
      ['sources', 'Website & photos', Globe2],
      ['direction', 'AI direction', Palette],
      ['overview', 'Overview', LayoutDashboard],
      ['assistant', 'Pod AI', Bot],
      ['assets', 'Assets', FileImage],
    ],
  },
  {
    label: 'Create & publish',
    items: [
      ['socials', 'Social accounts', MessageSquareText],
      ['content', 'Social content', Sparkles],
      ['calendar', 'Calendar', CalendarDays],
      ['campaigns', 'Campaigns', Megaphone],
    ],
  },
  {
    label: 'Grow',
    items: [
      ['analytics', 'Analytics', BarChart3],
      ['team', 'Collaborations', Users],
      ['launch', 'Coming soon', Mail],
      ['budget', 'Budget & ads', CircleDollarSign],
    ],
  },
];

const INITIAL_ANALYSIS = {
  summary: 'A premium skincare brand that makes effective routines feel calm, clear, and attainable.',
  tone: 'Expert, reassuring, modern luxury',
  audience: 'Time-poor customers aged 24–40 who want visible results without a complicated routine.',
  offer: 'A seasonal barrier-repair bundle supported by education, proof, and a confident guarantee.',
  opportunity: 'Lead with hydration and barrier education, then retarget engaged visitors with the bundle.',
  pillars: ['Visible results', 'Simple rituals', 'Ingredient authority'],
  platforms: ['instagram', 'tiktok', 'facebook', 'email'],
  brand_colours: [
    { name: 'Soft Ivory', hex: '#F5EFE6' },
    { name: 'Sage', hex: '#9CAF88' },
    { name: 'Terracotta', hex: '#C67B5C' },
    { name: 'Deep Navy', hex: '#1F2A44' },
  ],
  geography: ['Australia', 'New Zealand', 'USA'],
};

// Keep public navigation separate from live Pod features.
const DEMO_TAB_GROUPS = TAB_GROUPS.map((group) => group.label === 'Grow'
  ? { ...group, items: [...group.items, ['competitors', 'Competitor Watch', Globe2], ['learning', 'Learning History', Activity]] }
  : group);

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

function DemoPodShowcase() {
  const [activeTab, setActiveTab] = useState('sources');
  const tabRefs = useRef({});
  const { pod, analysis, assets, messages, posts, competitors, learningHistory } = DEMO_WORKSPACE;
  const logoAssets = assets.filter((asset) => asset.assetRole === 'logo');
  const brandPhotos = assets.filter((asset) => asset.assetRole === 'brand_photo');
  const selectedPlatforms = analysis.platforms.map((key) => getPlatform(key)).filter(Boolean);
  const calendarPostDays = new Set([2, 5, 9, 12, 16, 19, 23, 26, 30]);

  const handleTabKeyDown = (event, key) => {
    const next = getNextDemoTab(key, event.key);
    if (!next) return;
    event.preventDefault();
    setActiveTab(next);
    tabRefs.current[next]?.focus();
  };

  const renderShowcasePanel = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <div className="pod-panel-stack">
            <div className="pod-overview-hero">
              <div><p className="eyebrow">Fictional showcase</p><h2>{pod.pod_name}</h2><p>{analysis.summary}</p></div>
              <StatusPill tone="green">Sample complete</StatusPill>
            </div>
            <section className="pod-metric-grid">
              <MetricCard label="Direction" value="Approved" detail="Fictional sample" />
              <MetricCard label="Content plan" value="9 dates" detail="Sample monthly calendar" />
              <MetricCard label="Publishing rhythm" value="3 days/week" detail="Example recommendation" />
              <MetricCard label="Channels" value="4" detail="No accounts connected" />
            </section>
            <section className="pod-dashboard-grid">
              <article className="pod-rich-card pod-next-card"><span className="pod-card-icon"><Activity size={18} /></span><div><small>Recommended next move</small><h3>Prepare launch creative</h3><p className="subtle">Example recommendation based on the fictional website and approved direction.</p></div></article>
              <article className="pod-rich-card"><div className="pod-card-heading"><div><small>Sample activity</small><h3>Content readiness</h3></div><StatusPill>Ready</StatusPill></div><div className="pod-chart" aria-label="Sample content readiness chart">{[36, 54, 48, 72, 64, 90, 86].map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}</div></article>
              <article className="pod-rich-card"><div className="pod-card-heading"><div><small>Sample completion</small><h3>100%</h3></div><Palette size={19} /></div><div className="pod-progress"><span style={{ width: '100%' }} /></div><ul className="pod-check-list"><li className="done"><Check /> Source added</li><li className="done"><Check /> Analysis generated</li><li className="done"><Check /> Direction approved</li><li className="done"><Check /> Content prepared</li></ul></article>
            </section>
          </div>
        );
      case 'assistant':
        return (
          <div className="pod-panel-stack pod-ai-panel">
            <header className="pod-panel-heading"><div><p className="eyebrow">Example conversation</p><h2>{pod.pod_name} AI</h2><p className="subtle">This is a prepared example. The public showcase does not send questions to AI.</p></div><StatusPill>Read-only sample</StatusPill></header>
            <div className="pod-ai-thread">{messages.map((message) => <article key={message.id} className={`pod-ai-message pod-ai-message-${message.role}`}><span>{message.role === 'assistant' ? 'Sample Pod AI' : 'Sample user'}</span><p>{message.content}</p></article>)}</div>
            <p className="pod-showcase-note">Create your own pod to ask questions using your private sources and saved brand direction.</p>
          </div>
        );
      case 'sources':
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">Fictional website & photos</p><h2>Brand analysis inputs</h2><p className="subtle">A complete sample of the information a real pod can organise after its owner provides the source.</p></div><StatusPill tone="green">Sample locked</StatusPill></header>
            <article className="pod-lock-card"><LockKeyhole size={22} /><div><strong>{pod.source_url}</strong><p>Reserved demonstration address. It is not a real business or connected website.</p></div></article>
            <div className="pod-asset-grid"><article className="pod-file-card"><Globe2 /><div><strong>{pod.source_url}</strong><small>Fictional primary website</small></div></article>{[...logoAssets, ...brandPhotos].map((asset) => <article className="pod-file-card" key={asset.id}><img src={asset.preview} alt="" /><div><strong>{asset.name}</strong><small>{asset.assetRole === 'logo' ? 'Sample brand logo' : 'Sample brand photo'}</small></div></article>)}</div>
          </div>
        );
      case 'direction':
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">Sample AI direction</p><h2>Approved launch direction</h2><p className="subtle">Prepared fictional output showing what a completed analysis can look like.</p></div><StatusPill tone="green">Sample approved</StatusPill></header>
            <section className="pod-insight-grid">{[['Brand summary', analysis.summary], ['Tone', analysis.tone], ['Audience', analysis.audience], ['Offer', analysis.offer], ['Strongest opportunity', analysis.opportunity]].map(([label, value]) => <article key={label}><small>{label}</small><p>{value}</p></article>)}</section>
            <article className="pod-rich-card"><small>Content pillars</small><div className="pod-chip-row">{analysis.pillars.map((pillar) => <span key={pillar}>{pillar}</span>)}</div></article>
            <article className="pod-rich-card"><small>Sample evidence</small><ul>{analysis.evidence.map((item) => <li key={item.source_reference}>{item.finding} <span className="subtle">({item.source_reference})</span></li>)}</ul></article>
          </div>
        );
      case 'assets':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Sample library</p><h2>Campaign assets</h2><p className="subtle">Prepared fictional images demonstrate how real pod assets are grouped without allowing public uploads.</p></div><StatusPill>Read-only sample</StatusPill></header><div className="pod-media-grid">{assets.map((asset) => <article key={asset.id}><img src={asset.preview} alt={asset.name} /><div><strong>{asset.name}</strong><small>{asset.assetRole === 'logo' ? 'Sample logo' : asset.assetRole === 'brand_photo' ? 'Sample brand photo' : 'Sample campaign creative'}</small></div></article>)}</div></div>;
      case 'socials':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Sample channel plan</p><h2>Recommended social accounts</h2><p className="subtle">These are example recommendations only. No public demo accounts are connected.</p></div><StatusPill>0 live connections</StatusPill></header><div className="pod-platform-select-grid">{selectedPlatforms.map((platform) => <article key={platform.key} className="pod-platform-select selected"><span className="pod-social-monogram">{platform.name.slice(0, 2)}</span><div><h3>{platform.name}</h3><p>{platform.focus}</p><small>Recommended in this fictional plan</small></div></article>)}</div><p className="pod-honesty-note">Provider connections are not live yet. Future connections would require official provider configuration and owner authorisation. This showcase cannot connect, post, or publish.</p></div>;
      case 'content':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Sample social manager</p><h2>Prepared campaign drafts</h2><p className="subtle">Fictional, read-only examples for each recommended channel.</p></div><StatusPill>{posts.length} sample drafts</StatusPill></header><div className="pod-post-list">{posts.map((post) => <article key={post.id} className="pod-post-card"><header><div><strong>{post.platformName}</strong><small>{post.characterCount} characters · {post.contentStyle}</small></div><StatusPill>Sample</StatusPill></header><img className="pod-post-photo" src={brandPhotos[0].preview} alt="Fictional Aurora Botanicals campaign" /><small className="pod-photo-source">Fictional sample creative</small><p className="pod-demo-post-copy">{post.content}</p></article>)}</div></div>;
      case 'calendar':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Sample June calendar</p><h2>Content calendar</h2><p className="subtle">A filled example showing the same approved campaign adapted for the selected channels.</p></div><StatusPill>Fictional schedule</StatusPill></header><div className="pod-cal-grid" aria-label="Fictional June content calendar">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day} className="pod-cal-dow">{day}</span>)}{Array.from({ length: 30 }, (_, index) => index + 1).map((date) => <div key={date} className={`pod-cal-day${calendarPostDays.has(date) ? ' pod-cal-post' : ''}`}><span className="pod-cal-date">{date}</span>{calendarPostDays.has(date) && <><span className="pod-cal-thumb"><img src={brandPhotos[0].preview} alt="" /></span><strong>Winter ritual</strong><span className="pod-cal-badges">{selectedPlatforms.slice(0, 2).map((platform) => <span key={platform.key}>{platform.name}</span>)}</span></>}</div>)}</div></div>;
      case 'campaigns':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Sample campaign</p><h2>Winter barrier launch</h2><p className="subtle">A completed fictional campaign board.</p></div><StatusPill tone="green">Sample approved</StatusPill></header><section className="pod-campaign-board">{['Brief', 'Creative', 'Schedule', 'Approval'].map((stage, index) => <article key={stage}><small>0{index + 1}</small><h3>{stage}</h3><p>{['Fictional website and offer analysed', 'Four sample channel drafts ready', 'Nine sample calendar dates prepared', 'Sample direction approved'][index]}</p><span className="complete" /></article>)}</section></div>;
      case 'analytics':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Fictional analytics</p><h2>Organic and campaign signals</h2><p className="subtle">Illustrative numbers only—no live accounts or customer data.</p></div><StatusPill>Sample data</StatusPill></header><section className="pod-metric-grid"><MetricCard label="Sample reach" value="18.4K" detail="Illustrative only" /><MetricCard label="Sample engagement" value="6.2%" detail="Illustrative only" /><MetricCard label="Sample clicks" value="1,247" detail="Illustrative only" /><MetricCard label="Sample conversions" value="84" detail="Illustrative only" /></section><article className="pod-rich-card"><div className="pod-card-heading"><div><small>Sample channel trend</small><h3>Eight fictional campaign days</h3></div><BarChart3 /></div><div className="pod-chart pod-chart-large">{[32, 46, 42, 60, 54, 76, 68, 88].map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}</div></article></div>;
      case 'team':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Sample collaboration</p><h2>People inside this fictional pod</h2><p className="subtle">Example roles only. The showcase cannot invite anyone.</p></div><StatusPill>Read-only sample</StatusPill></header><article className="pod-team-row"><span>AS</span><div><strong>Aurora Studio</strong><small>Fictional owner · Full pod access</small></div><StatusPill tone="green">Sample</StatusPill></article><article className="pod-team-row"><span>MC</span><div><strong>Mia Chen</strong><small>Fictional collaborator · Content review</small></div><StatusPill>Sample</StatusPill></article></div>;
      case 'launch':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Sample launch page</p><h2>Prepared email-capture concept</h2><p className="subtle">Visual example only. It does not accept or save email addresses.</p></div><StatusPill>Not published</StatusPill></header><article className="pod-launch-preview"><span className="pod-launch-orbit"><Sparkles /></span><p className="eyebrow">Aurora Botanicals</p><h2>Winter skin, restored.</h2><p>A calmer barrier ritual is almost here. Join the fictional launch story.</p><div className="pod-demo-email-preview"><span>you@example.com</span><strong>Notify me</strong></div><small>Fictional preview · No form or data collection</small></article></div>;
      case 'budget':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Fictional budget & ads</p><h2>Sample spend plan</h2><p className="subtle">Illustrative planning data only. The showcase cannot approve or change spend.</p></div><StatusPill>Sample data</StatusPill></header><section className="pod-metric-grid"><MetricCard label="Sample budget" value="$2,000" detail="Illustrative monthly plan" /><MetricCard label="Sample spend" value="$847" detail="Not live spend" /><MetricCard label="Sample revenue" value="$4,230" detail="Not live revenue" /><MetricCard label="Sample ROAS" value="4.99x" detail="Not measured" /></section><article className="pod-budget-recommendation"><span><CircleDollarSign /></span><div><small>Sample AI recommendation</small><h3>Test more of the fictional budget on the stronger Reel creative.</h3><p>A real pod would require an authorised user and connected provider before any spend could change.</p></div></article></div>;
      case 'competitors':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Fictional competitor snapshot</p><h2>Competitor Watch</h2><p className="subtle">Prepared public-page comparisons only. No continuous monitoring, traffic estimates, ad results or real provider data.</p></div><StatusPill>Fictional sample</StatusPill></header>{competitors.map((competitor) => <article className="pod-rich-card" key={competitor.name}><h3>{competitor.name}</h3><p>{competitor.observation}</p><small>{competitor.sourceReference} · {competitor.sourceUrl}</small></article>)}</div>;
      case 'learning':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Fictional learning history</p><h2>Learning History</h2><p className="subtle">Prepared sample events, not real saved actions or measured outcomes.</p></div><StatusPill>Fictional sample</StatusPill></header>{learningHistory.map((entry) => <article className="pod-rich-card" key={entry.at}><small><time dateTime={entry.at}>{entry.at.slice(0, 10)}</time></small><h3>{entry.title}</h3><p>{entry.detail}</p></article>)}</div>;
      default:
        return null;
    }
  };

  return (
    <section className="pod-workspace pod-showcase" data-pod-mode="showcase">
      <div className="pod-demo-banner" role="note"><Sparkles size={15} /><span>Read-only fictional showcase — explore each section; nothing can be edited, connected, sent, saved, or published.</span><Link to="/signup">Create a working pod →</Link></div>
      <Link to="/" className="pod-back-link">&larr; Back to Dovroyn</Link>
      <header className="pod-workspace-topbar"><div className="pod-workspace-title"><span className="pod-brand-orb"><Sparkles size={18} /></span><div><p className="eyebrow">{pod.brand_name} · fictional</p><h2>{pod.pod_name}</h2></div></div><div className="pod-workspace-actions"><StatusPill>Showcase only</StatusPill></div></header>
      <div className="pod-workspace-body">
        <aside className="pod-workspace-nav" role="tablist" aria-label="Demo pod sections" aria-orientation="vertical">
          {DEMO_TAB_GROUPS.map((group) => <div key={group.label} role="presentation"><p role="presentation">{group.label}</p>
            {group.items.map(([key, label, Icon]) => <button key={key}
              ref={(node) => { tabRefs.current[key] = node; }}
              id={`demo-tab-${key}`} role="tab" aria-selected={activeTab === key}
              aria-controls="demo-panel" tabIndex={activeTab === key ? 0 : -1}
              className={activeTab === key ? 'active' : ''} type="button"
              onKeyDown={(event) => handleTabKeyDown(event, key)} onClick={() => setActiveTab(key)}>
              <Icon size={16} aria-hidden="true" /><span>{label}</span>
            </button>)}
          </div>)}
        </aside>
        <div className="pod-workspace-panel" role="tabpanel" id="demo-panel"
          aria-labelledby={`demo-tab-${activeTab}`} tabIndex={0}>{renderShowcasePanel()}</div>
      </div>
    </section>
  );
}

export default function PodWorkspace({ demo = false, session, subscription }) {
  if (!canMutatePod(demo)) return <DemoPodShowcase />;
  return <LivePodWorkspace session={session} subscription={subscription} />;
}

function LivePodWorkspace({ session, subscription }) {
  const { podId } = useParams();
  const [pod, setPod] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [analysis, setAnalysis] = useState(null);
  const [analysisState, setAnalysisState] = useState('idle');
  const [aiMessages, setAiMessages] = useState([]);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiSending, setAiSending] = useState(false);
  const [directionApproved, setDirectionApproved] = useState(false);
  const [directionMutation, setDirectionMutation] = useState('');
  const [directionSaveFailed, setDirectionSaveFailed] = useState(false);
  const [contentGenerating, setContentGenerating] = useState(false);
  const directionOperation = useRef('');
  const [overrideText, setOverrideText] = useState('');
  const [sources, setSources] = useState([]);
  const [sourceType, setSourceType] = useState('website');
  const [sourceUrl, setSourceUrl] = useState('');
  const [assets, setAssets] = useState([]);
  const [selectedPlatformKeys, setSelectedPlatformKeys] = useState([]);
  const [posts, setPosts] = useState([]);
  const [calendarItems, setCalendarItems] = useState([]);
  const [calendarMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [campaign, setCampaign] = useState(null);
  const [observancesEnabled, setObservancesEnabled] = useState(false);
  const [holidayPreference, setHolidayPreference] = useState(null);
  const [budget, setBudget] = useState(null);
  const [plannedBudgetInput, setPlannedBudgetInput] = useState('');
  const [budgetNotes, setBudgetNotes] = useState('');
  const [budgetRecommendation, setBudgetRecommendation] = useState('');
  const [budgetDecision, setBudgetDecision] = useState('pending');
  const [operationalMutation, setOperationalMutation] = useState('');
  const operationalOperation = useRef('');
  const operationalLifecycle = useRef(null);
  const currentPodId = useRef(podId);
  currentPodId.current = podId;
  const hasPlatformSelection = useRef(false);
  const [modal, setModal] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const plan = getPlan(subscription?.tier || 'free');
  const sourceLocked = Boolean(pod?.source_locked_at || analysis);
  const logoAssets = assets.filter((asset) => asset.assetRole === 'logo');
  const brandPhotos = assets.filter((asset) => asset.assetRole === 'brand_photo');
  const selectedSource = POD_SOURCE_TYPES.find((source) => source.value === sourceType);
  const monthItems = calendarItems.filter((item) => item.scheduled_date.startsWith(calendarMonth));
  const campaignState = campaign?.status ? campaign.status[0].toUpperCase() + campaign.status.slice(1) : 'Draft';
  const targetCountry = pod?.target_country === 'Australia' ? 'AU' : String(pod?.target_country || '').trim().toUpperCase();
  const budgetCurrency = targetCountry === 'AU' ? 'AUD' : '';

  useEffect(() => {
    const lifecycle = { podId, active: true };
    operationalLifecycle.current = lifecycle;
    operationalOperation.current = '';
    setOperationalMutation('');
    setNotice('');
    if (!supabaseConfigured || !podId) {
      setLoading(false);
      return () => { lifecycle.active = false; };
    }

    let mounted = true;
    setLoading(true);
    setLoadError('');
    loadPodWorkspace(podId).then(async (workspace) => {
      if (!mounted) return;
      setPod(workspace.pod || null);
      setSourceType(workspace.pod?.source_type || (workspace.pod?.source_url ? 'website' : 'photos'));
      setSourceUrl(workspace.pod?.source_url || '');
      setSources(workspace.sources || []);
      setAiMessages(workspace.messages || []);
      setDirectionApproved(isPodDirectionApprovalCurrent(workspace.pod, workspace.preferences));
      const operational = restoreOperationalState(workspace);
      hasPlatformSelection.current = operational.platformKeys !== null;
      setSelectedPlatformKeys(operational.platformKeys || []);
      setCalendarItems(operational.calendarItems);
      setCampaign(operational.campaign);
      setBudget(operational.budget);
      setPlannedBudgetInput(operational.budget ? String(operational.budget.planned_budget) : '');
      setBudgetNotes(operational.budget?.notes || '');
      setHolidayPreference(operational.holidayPreference);
      setObservancesEnabled(operational.holidayPreference?.include_religious_observances === true);
      setBudgetDecision(operational.budgetDecision);
      setBudgetRecommendation(operational.budgetRecommendation || 'Review how your planned budget is allocated before authorising any provider spend.');
      if (workspace.analysis) {
        let platformKeys = [];
        let pillars = [];
        try { platformKeys = JSON.parse(workspace.analysis.social_recommendations || '[]'); } catch { platformKeys = []; }
        try { pillars = JSON.parse(workspace.analysis.content_ideas || '[]'); } catch { pillars = []; }
        const restoredAnalysis = workspace.restoredAnalysis || {
          summary: workspace.analysis.brand_summary,
          tone: workspace.analysis.tone,
          audience: workspace.analysis.audience,
          offer: workspace.analysis.offer_direction,
          opportunity: workspace.analysis.campaign_angles,
          evidence: workspace.analysis.evidence || [],
          confidence: workspace.analysis.confidence == null ? null : Number(workspace.analysis.confidence),
          source_captured_at: workspace.analysis.source_captured_at,
          personal_data_detected: Boolean(workspace.analysis.personal_data_detected),
          personal_data_categories: workspace.analysis.personal_data_categories || [],
          platforms: platformKeys,
          pillars,
        };
        platformKeys = Array.isArray(restoredAnalysis.platforms) ? restoredAnalysis.platforms : [];
        const restoredPillars = Array.isArray(restoredAnalysis.pillars) ? restoredAnalysis.pillars : [];
        if (!hasPlatformSelection.current) setSelectedPlatformKeys(platformKeys.length ? platformKeys : INITIAL_ANALYSIS.platforms);
        setAnalysis(restorePodDirection({
          ...restoredAnalysis,
          platforms: platformKeys.length ? platformKeys : INITIAL_ANALYSIS.platforms,
          pillars: restoredPillars.length ? restoredPillars : INITIAL_ANALYSIS.pillars,
        }, workspace.preferences));
        setAnalysisState('ready');
      } else {
        setActiveTab('sources');
      }
      if (workspace.posts.length) {
        setPosts(workspace.posts.map((post) => {
          const platform = getPlatform(post.platform);
          return {
            id: post.id,
            platformKey: post.platform,
            platformName: platform?.name || post.platform,
            content: post.body,
            characterCount: post.body.length,
            contentStyle: platform?.rules?.contentStyle || 'Platform-specific',
            status: post.status,
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
    }).catch((error) => {
      if (mounted) { setLoadError(error.message || 'The Pod state could not be loaded.'); setPod(null); setLoading(false); }
    });
    return () => { mounted = false; lifecycle.active = false; };
  }, [podId]);

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

  const togglePlatform = async (platformKey) => {
    if (operationalOperation.current) return;
    const previous = selectedPlatformKeys;
    const next = selectedPlatformKeys.includes(platformKey)
      ? selectedPlatformKeys.filter((key) => key !== platformKey)
      : [...selectedPlatformKeys, platformKey];
    setSelectedPlatformKeys(next);
    await saveOperational('platforms', async (isCurrent) => {
      try {
        await savePlatformSelection(pod.id, next);
        if (isCurrent()) hasPlatformSelection.current = true;
      } catch (error) {
        if (isCurrent()) setSelectedPlatformKeys(previous);
        throw error;
      }
    });
  };

  const allTabs = useMemo(() => TAB_GROUPS.flatMap((group) => group.items), []);
  const commands = useMemo(() => [
    ...allTabs.map(([key, label]) => ({ group: 'Open tab', label, action: () => setActiveTab(key) })),
    { group: 'Pod action', label: analysis ? 'Review AI analysis' : 'Run AI analysis', action: () => { if (analysis) setActiveTab('direction'); else { setActiveTab('sources'); window.setTimeout(() => runAnalysis(), 0); } } },
    { group: 'Pod action', label: 'Ask this pod AI', action: () => setActiveTab('assistant') },
    { group: 'Pod action', label: sourceLocked ? 'View locked brand source' : 'Set primary source and photos', action: () => setActiveTab('sources') },
    { group: 'Pod action', label: 'Generate social content', action: () => { setActiveTab('content'); window.setTimeout(() => generateContent(), 0); } },
  ], [allTabs, analysis, directionApproved, sourceLocked]);

  const showNotice = (message) => setNotice(message);

  const saveOperational = async (operation, save) => {
    if (operationalOperation.current) return;
    const lifecycle = operationalLifecycle.current;
    const originPodId = pod?.id;
    const isCurrent = () => lifecycle?.active && operationalLifecycle.current === lifecycle
      && currentPodId.current === originPodId && lifecycle.podId === originPodId;
    if (!isCurrent()) return;
    const token = { operation, lifecycle };
    operationalOperation.current = token;
    setOperationalMutation(operation);
    try { await save(isCurrent); }
    catch (error) { if (isCurrent()) showNotice(error.message || 'This Pod change could not be saved.'); }
    finally {
      if (isCurrent() && operationalOperation.current === token) {
        operationalOperation.current = '';
        setOperationalMutation('');
      }
    }
  };

  const saveObservances = (enabled) => saveOperational('observances', async (isCurrent) => {
    const saved = await saveHolidayPreference(pod.id, {
      country_code: targetCountry,
      region_code: holidayPreference?.region_code || null,
      include_public_holidays: holidayPreference?.include_public_holidays !== false,
      include_religious_observances: enabled === true,
      selected_observances: holidayPreference?.selected_observances || [],
    });
    if (!isCurrent()) return;
    setHolidayPreference(saved);
    setObservancesEnabled(saved.include_religious_observances === true);
    showNotice('Observance preference saved. No religion or observance was guessed.');
  });

  const decideCampaign = (status) => saveOperational('campaign', async (isCurrent) => {
    const saved = await saveCampaignDecision(pod.id, {
      campaignId: campaign?.id, name: campaign?.name || `${pod.pod_name} campaign`, status,
      objective: campaign?.objective || analysis?.offer || null,
      brief: campaign?.brief || { strategy: analysis?.opportunity || '', platforms: selectedPlatformKeys },
    });
    if (!isCurrent()) return;
    setCampaign(saved);
    showNotice(status === 'approved' ? 'Campaign approval saved. Publishing still requires connected accounts.' : 'Campaign returned to draft and saved.');
  });

  const saveBudget = () => saveOperational('budget', async (isCurrent) => {
    if (!plannedBudgetInput.trim()) throw new Error('Enter a planned monthly budget.');
    const saved = await saveBudgetPlan(pod.id, { plannedBudget: Number(plannedBudgetInput), notes: budgetNotes });
    if (!isCurrent()) return;
    setBudget(saved);
    setPlannedBudgetInput(String(saved.planned_budget));
    showNotice('Monthly budget plan saved. No provider spend was changed.');
  });

  const decideBudget = (decision) => saveOperational('budget-decision', async (isCurrent) => {
    await savePreferenceDecision(pod.id, 'budget_recommendation_decision', { decision, scope: 'plan_only' });
    if (!isCurrent()) return;
    setBudgetDecision(decision);
    showNotice(`Recommendation ${decision} for the plan only. No provider spend was changed.`);
  });

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
    if (!pod?.id) return;
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
    if (nextAssets.length) showNotice(`${nextAssets.length} asset${nextAssets.length === 1 ? '' : 's'} added to this pod.`);
    event.target.value = '';
    if (pod?.id && session?.user?.id) {
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
        showNotice(`${savedAssets.length} asset${savedAssets.length === 1 ? '' : 's'} saved to private pod storage.`);
      } catch (error) {
        setAssets((current) => current.filter((asset) => !nextAssets.some((optimistic) => optimistic.id === asset.id)));
        nextAssets.forEach((asset) => URL.revokeObjectURL(asset.preview));
        showNotice(error.message || 'The private image upload could not be saved.');
      }
    }
  };

  const runAnalysis = async () => {
    if (sourceLocked) {
      setActiveTab('direction');
      showNotice('This pod has already been analysed. Use an override to adjust its direction.');
      return;
    }
    const setupError = validatePodSetup({
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
    setDirectionApproved(false);
    try {
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
      const nextAnalysis = result.analysis;
      setPod((current) => ({ ...current, source_locked_at: result.sourceLockedAt ?? new Date().toISOString(), status: 'awaiting_direction' }));
      setAnalysis(nextAnalysis);
      if (!hasPlatformSelection.current) setSelectedPlatformKeys(nextAnalysis.platforms || []);
      setAnalysisState('ready');
      setActiveTab('direction');
      const snapshotSaved = await saveWebsiteIntelligenceSnapshot(pod.id, nextAnalysis);
      showNotice(snapshotSaved
        ? 'Analysis ready for your approval.'
        : 'Analysis is saved and this source is locked, but the rich intelligence snapshot could not be saved. Reload before approving if you need to confirm every detail.');
    } catch (error) {
      setAnalysisState('idle');
      showNotice(error.message || 'AI analysis could not run. Check the server configuration.');
    }
  };

  const approveDirection = async () => {
    if (directionOperation.current || directionSaveFailed || !analysis) return;
    directionOperation.current = 'approving';
    setDirectionMutation('approving');
    setDirectionApproved(false);
    try {
      const savedPod = await approvePodDirection(pod?.id, analysis);
      setPod(savedPod);
      setDirectionApproved(true);
      setModal(null);
      showNotice('Brand direction approved. Content generation is unlocked.');
    } catch (error) {
      showNotice(error.message || 'Direction approval could not be saved. Please try again.');
    } finally {
      directionOperation.current = '';
      setDirectionMutation('');
    }
  };

  const saveOverride = async () => {
    const direction = overrideText.trim();
    if (!direction || directionOperation.current) return;
    directionOperation.current = 'override';
    setDirectionMutation('override');
    setDirectionApproved(false);
    try {
      const { pod: savedPod } = await savePodDirectionOverride(pod?.id, direction);
      setPod(savedPod);
      setAnalysis((current) => ({ ...current, tone: direction, userDirection: direction }));
      setDirectionSaveFailed(false);
      setOverrideText('');
      setModal(null);
      showNotice('Override saved. Review the updated direction before approving it.');
    } catch {
      // If the response is uncertain, keep content generation locked until the
      // user retries or reloads the server-confirmed pod state.
      setDirectionSaveFailed(true);
      showNotice('Direction save could not be confirmed. Retry saving or reload before approving.');
    } finally {
      directionOperation.current = '';
      setDirectionMutation('');
    }
  };

  const generateContent = async () => {
    if (directionOperation.current || directionSaveFailed) return;
    if (!analysis) {
      setModal({ type: 'analysis-first' });
      return;
    }
    if (!directionApproved) {
      setModal({ type: 'approval-first' });
      return;
    }
    if (!selectedPlatformKeys.length) {
      showNotice('Select at least one planning platform before generating content.');
      return;
    }
    directionOperation.current = 'generating';
    setContentGenerating(true);
    try {
      if (!session?.access_token) throw new Error('Sign in again before generating content.');
      const result = await requestSocialContent({
        accessToken: session.access_token,
        podId: pod.id,
        platforms: selectedPlatformKeys,
        contentDay: new Date().toISOString().slice(0, 10),
      });
      const generated = result.posts.map((post, index) => ({ ...post, id: `${post.platformKey}-${Date.now()}-${index}`, status: 'Draft' }));
      setPosts(generated);
      if (pod?.id) {
        const saved = await saveSocialPosts(pod.id, generated);
        setPosts((current) => current.map((post, index) => ({ ...post, id: saved[index]?.id || post.id })));
      }
      setActiveTab('content');
      showNotice(`${generated.length} platform-specific drafts generated.`);
    } catch (error) {
      showNotice(error.message || 'Content generation could not run.');
    } finally {
      directionOperation.current = '';
      setContentGenerating(false);
    }
  };

  const createCalendar = async () => {
    if (operationalOperation.current) return;
    if (monthItems.length) { showNotice('This month already has a saved calendar. No duplicates were created.'); return; }
    if (!posts.length) {
      setModal({ type: 'content-first' });
      return;
    }
    await saveOperational('calendar', async (isCurrent) => {
      const items = buildCalendarItems({ month: calendarMonth, posts, platformKeys: selectedPlatformKeys,
        weeklyPostingDays: plan.weeklyPostingDays, monthlyContentDays: plan.monthlyContentDays });
      if (!items.length) throw new Error('No calendar days are available. Check your plan allowance and selected platform drafts.');
      const saved = await saveCalendarItems(pod.id, items);
      if (!isCurrent()) return;
      setCalendarItems((current) => [...current.filter((item) => !item.scheduled_date.startsWith(calendarMonth)), ...saved]);
      showNotice('Calendar drafts saved for this month. Nothing was approved or published.');
    });
  };

  const savePostEdit = async (post) => {
    try {
      await updateSocialPost(post.id, post.content);
      showNotice(`${post.platformName} draft saved.`);
    } catch (error) {
      showNotice(error.message || 'The draft edit could not be saved.');
    }
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
      if (!session?.access_token) throw new Error('Sign in again before using this pod AI.');
      const result = await askPodAssistant({ accessToken: session.access_token, podId: pod.id, question });
      const answer = result.answer;
      const memorySaved = result.memorySaved;
      setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: answer }]);
      if (!memorySaved) showNotice('The answer is visible, but pod memory needs the workspace migration before it can be saved.');
    } catch (error) {
      showNotice(error.message || 'This pod AI could not answer right now.');
    } finally {
      setAiSending(false);
    }
  };

  if (loading) return <div className="pod-workspace-loading">Opening this pod…</div>;
  if (!pod) return <EmptyState icon={BriefcaseBusiness} title={loadError ? 'Pod could not be loaded' : 'Pod not found'} body={loadError || 'This pod is unavailable or does not belong to the signed-in account.'} />;

  const renderPanel = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <div className="pod-panel-stack">
            <div className="pod-overview-hero">
              <div>
                <p className="eyebrow">Inside this pod</p>
                <h2>{pod.pod_name}</h2>
                <p>{analysis?.summary || 'Add the website and brand photos, then ask this pod to build its direction.'}</p>
              </div>
              <button className="button button-primary" type="button" onClick={() => analysis ? setActiveTab('direction') : runAnalysis()} disabled={analysisState === 'running'}>
                <Sparkles size={16} /> {analysisState === 'running' ? 'Analysing…' : analysis ? 'Review AI direction' : 'Run AI analysis'}
              </button>
            </div>
            <section className="pod-metric-grid">
              <MetricCard label="Direction" value={directionApproved ? 'Approved' : analysis ? 'Review' : 'Not analysed'} detail="Controls future pod output" />
              <MetricCard label="Content allowance" value={`${plan.monthlyContentDays} days`} detail="Resets monthly on your billing date" />
              <MetricCard label="Publishing rhythm" value={`${plan.weeklyPostingDays} days/week`} detail="Posting days, not total posts" />
              <MetricCard label="Connected accounts" value="0" detail="Provider sign-in required" />
            </section>
            {analysis && (analysis.visual_style || analysis.audience_fit) && (
              <section className="pod-insight-grid">
                {analysis.visual_style && <article><small>Visual style</small><p>{analysis.visual_style}</p></article>}
                {analysis.audience_fit && <article><small>Audience fit</small><p>{analysis.audience_fit}</p></article>}
              </section>
            )}
            <section className="pod-dashboard-grid">
              <article className="pod-rich-card pod-next-card">
                <span className="pod-card-icon"><Activity size={18} /></span>
                <div><small>Recommended next move</small><h3>{analysis ? 'Approve the brand direction' : 'Add source material and run analysis'}</h3><p className="subtle">The pod will not publish or change ad spend without the required approval.</p></div>
                <button className="icon-button" type="button" aria-label="Open recommended next step" onClick={() => setActiveTab(analysis ? 'direction' : 'sources')}><ChevronRight /></button>
              </article>
              <article className="pod-rich-card">
                <div className="pod-card-heading"><div><small>Monthly activity</small><h3>Content readiness</h3></div><StatusPill>{posts.length ? 'Generated' : 'Waiting'}</StatusPill></div>
                <div className="pod-chart" aria-label="Content readiness chart">
                  {[36, 54, 48, 72, 64, posts.length ? 90 : 42, posts.length ? 86 : 38].map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}
                </div>
                <div className="pod-chart-labels"><span>Week 1</span><span>Today</span></div>
              </article>
              <article className="pod-rich-card">
                <div className="pod-card-heading"><div><small>Pod completion</small><h3>{analysis ? (directionApproved ? '60%' : '42%') : '18%'}</h3></div><Palette size={19} /></div>
                <div className="pod-progress"><span style={{ width: analysis ? (directionApproved ? '60%' : '42%') : '18%' }} /></div>
                <ul className="pod-check-list">
                  <li className={pod.source_url || sources.length ? 'done' : ''}><Check /> Source added</li>
                  <li className={analysis ? 'done' : ''}><Check /> Analysis generated</li>
                  <li className={directionApproved ? 'done' : ''}><Check /> Direction approved</li>
                  <li className={posts.length ? 'done' : ''}><Check /> Content generated</li>
                </ul>
              </article>
            </section>
          </div>
        );
      case 'assistant':
        return (
          <div className="pod-panel-stack pod-ai-panel">
            <header className="pod-panel-heading"><div><p className="eyebrow">Private pod intelligence</p><h2>{pod.pod_name} AI</h2><p className="subtle">One Dovroyn AI service, isolated memory for this pod only. It uses this pod's sources, approved direction and corrections.</p></div><StatusPill tone="green">Pod-isolated</StatusPill></header>
            <div className="pod-ai-thread" aria-live="polite">
              {aiMessages.length === 0 && <div className="pod-ai-welcome"><Bot size={22} /><strong>Ask this pod anything</strong><p>I can explain the analysis, refine the direction, plan campaigns or help shape platform-specific content.</p></div>}
              {aiMessages.map((message) => <article key={message.id || `${message.role}-${message.created_at}`} className={`pod-ai-message pod-ai-message-${message.role}`}><span>{message.role === 'assistant' ? 'Pod AI' : 'You'}</span><p>{message.content}</p></article>)}
              {aiSending && <article className="pod-ai-message pod-ai-message-assistant"><span>Pod AI</span><p>Thinking inside this pod…</p></article>}
            </div>
            <form className="pod-ai-composer" onSubmit={askPodAi}>
              <textarea aria-label="Ask this pod AI" rows={3} value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} placeholder="Ask about this brand, campaign, analysis or content…" maxLength={2000} />
              <button className="button button-primary" type="submit" disabled={!aiQuestion.trim() || aiSending}><Send size={16} /> Ask pod AI</button>
            </form>
            <small className="pod-ai-privacy">This AI cannot publish, connect accounts or spend money without the separate provider connection and approval workflow.</small>
          </div>
        );
      case 'sources':
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">One pod, one source</p><h2>Brand analysis inputs</h2><p className="subtle">Choose one website, social page, Shopify store, or photos-only source. Add one logo and up to five photos, then analyse and lock this pod.</p></div>{sourceLocked && <StatusPill tone="green">Source locked</StatusPill>}</header>
            <article className="pod-note-card"><strong>Website photos first. Asset folder second.</strong><p>Every post and campaign uses the photos from this website before anything else. The Asset folder is only for extras — a Christmas party, a flash sale, a seasonal push.</p></article>
            {sourceLocked ? (
              <article className="pod-lock-card"><LockKeyhole size={22} /><div><strong>This pod is permanently tied to its analysed source.</strong><p>Create another pod for a different website, social page, Shopify store, or brand. This prevents one subscription pod from being reused for multiple businesses.</p></div></article>
            ) : (
              <>
                <form className="pod-source-form pod-primary-source-form" onSubmit={savePrimarySource}>
                  <label>Primary source type
                    <select value={sourceType} onChange={(event) => { setSourceType(event.target.value); if (event.target.value === 'photos') setSourceUrl(''); }}>
                      {POD_SOURCE_TYPES.map((source) => <option value={source.value} key={source.value}>{source.label}</option>)}
                    </select>
                  </label>
                  {sourceNeedsUrl(sourceType) && <label>One primary {selectedSource?.label.toLowerCase()} URL<input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder={selectedSource?.placeholder} required /></label>}
                  <button className="button button-ghost" type="submit">Save primary source</button>
                </form>
                <div className="pod-brand-upload-grid">
                  <label className="pod-upload-zone">
                    <Upload size={24} />
                    <strong>{logoAssets.length ? 'Logo added' : 'Add one brand logo'}</strong>
                    <span>PNG, JPG, or WebP. One logo per pod.</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" disabled={logoAssets.length >= 1} onChange={(event) => addAssets(event, 'logo')} />
                  </label>
                  <label className="pod-upload-zone">
                    <Upload size={24} />
                    <strong>Add up to {MAX_BRAND_PHOTOS} brand or product photos</strong>
                    <span>{brandPhotos.length}/{MAX_BRAND_PHOTOS} added. PNG, JPG, or WebP.</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={brandPhotos.length >= MAX_BRAND_PHOTOS} onChange={(event) => addAssets(event, 'brand_photo')} />
                  </label>
                </div>
                <div className="pod-analysis-lock-action"><div><strong>Ready to build this pod?</strong><p>Analysis generates the brand direction and permanently locks these inputs to this pod.</p></div><button className="button button-primary" type="button" onClick={runAnalysis} disabled={analysisState === 'running'}><Sparkles size={16} /> {analysisState === 'running' ? 'Analysing…' : 'Analyse and lock pod'}</button></div>
              </>
            )}
            <div className="pod-asset-grid">
              {sourceUrl && <article className="pod-file-card"><Globe2 /><div><strong>{sourceUrl}</strong><small>{selectedSource?.label || 'Primary source'}</small></div></article>}
              {[...logoAssets, ...brandPhotos].map((asset) => <article className="pod-file-card" key={asset.id}><img src={asset.preview} alt="" /><div><strong>{asset.name}</strong><small>{asset.assetRole === 'logo' ? 'Brand logo' : `Brand photo · ${Math.ceil(asset.size / 1024)} KB`}</small></div></article>)}
            </div>
          </div>
        );
      case 'direction':
        if (analysisState === 'running') return <EmptyState icon={Sparkles} title="This pod is analysing the source" body="It is mapping the brand, audience, offer, strongest opportunity, and recommended platforms." />;
        if (!analysis) return <EmptyState icon={Bot} title="No analysis yet" body="Add a website or photos, then run this pod's AI analysis." action={runAnalysis} actionLabel="Run AI analysis" />;
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">AI direction</p><h2>Review before content is generated</h2><p className="subtle">Approve the proposal or teach this pod what to change.</p></div><StatusPill tone={directionApproved ? 'green' : 'gold'}>{directionApproved ? 'Approved' : 'Needs review'}</StatusPill></header>
            <section className="pod-insight-grid">
              {[['Brand summary', analysis.summary], ['Tone', analysis.tone], ['Audience', analysis.audience], ['Offer', analysis.offer], ['Strongest opportunity', analysis.opportunity]].map(([label, value]) => <article key={label}><small>{label}</small><p>{value}</p></article>)}
            </section>
            {Array.isArray(analysis.products_services) && analysis.products_services.length > 0 && (
              <article className="pod-rich-card"><small>Products &amp; services</small><div className="pod-chip-row">{analysis.products_services.map((item) => <span key={item}>{item}</span>)}</div></article>
            )}
            {(analysis.visual_style || analysis.audience_fit) && (
              <section className="pod-insight-grid">
                {analysis.visual_style && <article><small>Visual style</small><p>{analysis.visual_style}</p></article>}
                {analysis.audience_fit && <article><small>Audience fit</small><p>{analysis.audience_fit}</p></article>}
              </section>
            )}
            {Array.isArray(analysis.site_structure) && analysis.site_structure.length > 0 && (
              <article className="pod-rich-card"><small>Site structure</small><div className="pod-chip-row">{analysis.site_structure.map((item) => <span key={item}>{item}</span>)}</div></article>
            )}
            {(analysis.best_landing_pages?.length > 0 || analysis.weak_pages?.length > 0) && (
              <section className="pod-insight-grid">
                {analysis.best_landing_pages?.length > 0 && <article><small>Best landing pages</small><ul>{analysis.best_landing_pages.map((item, index) => <li key={`${item.source_reference}-${index}`}>{item.reason} <span className="subtle">({item.source_reference})</span></li>)}</ul></article>}
                {analysis.weak_pages?.length > 0 && <article><small>Pages to strengthen</small><ul>{analysis.weak_pages.map((item, index) => <li key={`${item.source_reference}-${index}`}>{item.issue} <span className="subtle">({item.source_reference})</span></li>)}</ul></article>}
              </section>
            )}
            {(analysis.seo_opportunities?.length > 0 || analysis.content_opportunities?.length > 0) && (
              <section className="pod-insight-grid">
                {analysis.seo_opportunities?.length > 0 && <article><small>SEO opportunities</small><ul>{analysis.seo_opportunities.map((item) => <li key={item}>{item}</li>)}</ul></article>}
                {analysis.content_opportunities?.length > 0 && <article><small>Content opportunities</small><ul>{analysis.content_opportunities.map((item) => <li key={item}>{item}</li>)}</ul></article>}
              </section>
            )}
            {Array.isArray(analysis.brand_colours) && analysis.brand_colours.length > 0 && (
              <article className="pod-rich-card"><small>Brand colours</small><div className="pod-colour-swatches">{analysis.brand_colours.map((colour) => <span key={colour.name} className="pod-colour-swatch" style={{ background: colour.hex }} title={colour.name} />)}</div><p className="pod-swatch-names">{analysis.brand_colours.map((colour) => colour.name).join(' · ')}</p></article>
            )}
            {Array.isArray(analysis.geography) && analysis.geography.length > 0 && (
              <article className="pod-rich-card"><small>Geography</small><div className="pod-chip-row">{analysis.geography.map((market) => <span key={market}>{market}</span>)}</div></article>
            )}
            {analysis.confidence != null && <article className="pod-rich-card"><small>Evidence confidence</small><p>{Math.round(analysis.confidence * 100)}% · Sources captured {analysis.source_captured_at ? new Date(analysis.source_captured_at).toLocaleDateString() : 'during analysis'}</p>{analysis.personal_data_detected && <p className="subtle">Personal data was detected in the source and excluded from the written analysis.</p>}</article>}
            {Array.isArray(analysis.evidence) && analysis.evidence.length > 0 && <article className="pod-rich-card"><small>Evidence</small><ul>{analysis.evidence.map((item, index) => <li key={`${item.source_reference}-${index}`}>{item.finding} <span className="subtle">({item.source_reference}, {Math.round(Number(item.confidence) * 100)}%)</span></li>)}</ul></article>}
            <article className="pod-rich-card"><small>Content pillars</small><div className="pod-chip-row">{analysis.pillars.map((pillar) => <span key={pillar}>{pillar}</span>)}</div></article>
            <div className="pod-action-row">
              <button className="button button-primary" type="button" disabled={Boolean(directionMutation) || contentGenerating || directionSaveFailed} onClick={approveDirection}><Check size={16} /> {directionMutation === 'approving' ? 'Saving approval…' : 'Approve direction'}</button>
              <button className="button button-ghost" type="button" disabled={Boolean(directionMutation) || contentGenerating} onClick={() => setModal({ type: 'override' })}><Settings2 size={16} /> Override AI choice</button>
            </div>
          </div>
        );
      case 'assets':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Library</p><h2>Campaign assets</h2><p className="subtle">Add working campaign images without changing the logo and brand sources locked during analysis.</p></div></header><label className="pod-upload-zone"><Upload size={24} /><strong>Add campaign assets</strong><span>These files stay inside this pod and do not replace its locked analysis source.</span><input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => addAssets(event, 'campaign_asset')} /></label>{assets.length ? <div className="pod-media-grid">{assets.map((asset) => <article key={asset.id}><img src={asset.preview} alt={asset.name} /><div><strong>{asset.name}</strong><small>{asset.assetRole === 'logo' ? 'Locked logo' : asset.assetRole === 'brand_photo' ? 'Locked brand photo' : 'Campaign asset'}</small></div></article>)}</div> : <EmptyState icon={FileImage} title="No campaign assets yet" body="Upload images for campaigns and social content after this pod's brand source has been analysed." />}</div>;
      case 'socials': {
        const recommendedKeys = analysis?.platforms || ['instagram', 'facebook', 'tiktok', 'email'];
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">Recommended channels</p><h2>Connect social accounts</h2><p className="subtle">The pod recommends the best platforms — tick or untick any of them. Your selection controls what content is generated and where it posts.</p></div></header>
            <div className="pod-platform-select-grid">
              {getPlanningPlatforms().map((platform) => {
                const selected = selectedPlatformKeys.includes(platform.key);
                const recommended = recommendedKeys.includes(platform.key);
                return (
                  <label key={platform.key} className={`pod-platform-select${selected ? ' selected' : ''}`}>
                    <input type="checkbox" checked={selected} disabled={Boolean(operationalMutation)} onChange={() => togglePlatform(platform.key)} />
                    <span className="pod-social-monogram">{platform.name.slice(0, 2)}</span>
                    <div><h3>{platform.name}</h3><p>{platform.focus}</p><small>{recommended ? 'Recommended by pod AI · ' : 'Your choice · '}Provider setup required for live connection</small></div>
                    {selected && <button className="button button-ghost button-sm" type="button" onClick={(event) => { event.preventDefault(); setModal({ type: 'connect', platform }); }}>Connect account</button>}
                  </label>
                );
              })}
            </div>
            <p className="pod-honesty-note">Dovroyn can plan for 30+ platforms. Live sign-in and publishing become available one provider at a time after its developer app, permissions, and API review are configured.</p>
          </div>
        );
      }
      case 'content': {
        const contentPhoto = [...brandPhotos, ...assets.filter((asset) => asset.assetRole === 'campaign_asset')][0] || null;
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">Social manager</p><h2>One campaign, posted everywhere</h2><p className="subtle">The same approved campaign goes to every selected platform on the same day — with photos from the website gallery first, the asset folder second.</p></div><button className="button button-primary" type="button" disabled={Boolean(directionMutation) || contentGenerating || directionSaveFailed} onClick={generateContent}><Sparkles size={16} /> {contentGenerating ? 'Generating…' : 'Generate content'}</button></header>
            {posts.length === 0 ? <EmptyState icon={MessageSquareText} title="No content drafts yet" body="Approve the brand direction, then generate the campaign for every selected platform." /> : <div className="pod-post-list">{posts.map((post) => <article key={post.id} className="pod-post-card"><header><div><strong>{post.platformName}</strong><small>{post.characterCount} characters · {post.contentStyle}</small></div><StatusPill>Draft</StatusPill></header>{contentPhoto && <img className="pod-post-photo" src={contentPhoto.preview} alt={contentPhoto.name} />}<small className="pod-photo-source">Photo source: {contentPhoto ? (contentPhoto.assetRole === 'brand_photo' ? 'website gallery (first)' : 'asset folder (extras)') : 'no photos yet — add website or campaign photos'}</small><textarea value={post.content} onChange={(event) => setPosts((current) => current.map((item) => item.id === post.id ? { ...item, content: event.target.value, characterCount: event.target.value.length } : item))} rows={5} /><footer><button className="button button-ghost button-sm" type="button" onClick={() => savePostEdit(post)}>Save edit</button><button className="button button-primary button-sm" type="button" onClick={() => { setActiveTab('calendar'); showNotice('Generate the calendar to save these drafts within your posting allowance.'); }}>Add to calendar</button></footer></article>)}</div>}
          </div>
        );
      }
      case 'calendar': {
        const [year, month] = calendarMonth.split('-').map(Number);
        const startOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
        const daysInMonth = new Date(year, month, 0).getDate();
        const calThumb = brandPhotos[0]?.preview || assets.find((asset) => asset.assetRole === 'campaign_asset')?.preview || '';
        return (
          <div className="pod-panel-stack">
            <header className="pod-panel-heading"><div><p className="eyebrow">Visible month · {calendarMonth}</p><h2>Content calendar</h2><p className="subtle">Up to {plan.monthlyContentDays} content days per allowance month and {plan.weeklyPostingDays} posting days each week. Saved calendar entries remain drafts until approved; provider publishing is unavailable.</p></div><button className="button button-primary" type="button" disabled={Boolean(operationalMutation)} onClick={createCalendar}><CalendarDays size={16} /> Generate calendar</button></header>
            <label className="pod-toggle"><input type="checkbox" checked={observancesEnabled} disabled={Boolean(operationalMutation)} onChange={(event) => saveObservances(event.target.checked)} /><span /><div><strong>Include selected religious observances</strong><small>Off by default. Dovroyn will never guess a user's religion. No observances are selected unless you supply them.</small></div></label>
            {monthItems.length ? (
              <div className="pod-cal-grid" aria-label={`Saved content calendar for ${calendarMonth}`}>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((dow) => <span key={dow} className="pod-cal-dow">{dow}</span>)}
                {Array.from({ length: startOffset }).map((_, index) => <div key={`pad-${index}`} className="pod-cal-day pod-cal-empty" />)}
                {Array.from({ length: daysInMonth }).map((_, index) => {
                  const date = index + 1;
                  const dateItems = monthItems.filter((item) => item.scheduled_date === `${calendarMonth}-${String(date).padStart(2, '0')}`);
                  const isPostDay = dateItems.length > 0;
                  return (
                    <div key={date} className={`pod-cal-day${isPostDay ? ' pod-cal-post' : ''}`}>
                      <span className="pod-cal-date">{date}</span>
                      {isPostDay && (
                        <>
                          <span className="pod-cal-thumb">{calThumb ? <img src={calThumb} alt="" /> : <Sparkles size={14} />}</span>
                          <strong>{dateItems[0].caption || dateItems[0].content_type}</strong>
                          <small>{[...new Set(dateItems.map((item) => item.status))].join(' · ')}</small>
                          <span className="pod-cal-badges">{[...new Set(dateItems.map((item) => item.platform))].map((key) => <span key={key}>{getPlatform(key)?.name || key}</span>)}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : <EmptyState icon={CalendarDays} title="Calendar not generated" body="Generate content drafts first, then the pod can place them within the paid allowance period." />}
          </div>
        );
      }
      case 'campaigns':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Campaigns</p><h2>{campaign?.name || `${pod.pod_name} campaign`}</h2></div><StatusPill>{campaignState}</StatusPill></header><section className="pod-campaign-board">{['Brief', 'Creative', 'Schedule', 'Approval'].map((stage, index) => <article key={stage}><small>0{index + 1}</small><h3>{stage}</h3><p>{[analysis ? 'Brand direction available' : 'Brand analysis required', `${posts.length} platform drafts available`, monthItems.length ? 'Calendar drafts saved' : 'Waiting for calendar generation', 'Publishing requires approval and connected providers'][index]}</p><span className={index < (campaignState === 'Approved' ? 4 : 2) ? 'complete' : ''} /></article>)}</section><div className="pod-action-row"><button className="button button-primary" type="button" disabled={Boolean(operationalMutation)} onClick={() => decideCampaign('approved')}>Approve campaign</button><button className="button button-ghost" type="button" disabled={Boolean(operationalMutation)} onClick={() => decideCampaign('draft')}>Return to draft</button></div></div>;
      case 'analytics':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Analytics</p><h2>Organic and campaign signals</h2><p className="subtle">Sample layout until connected platforms provide real data.</p></div><StatusPill>Preview data</StatusPill></header><section className="pod-metric-grid"><MetricCard label="Reach" value="18.4K" detail="+12.8% vs prior period" /><MetricCard label="Engagement" value="6.2%" detail="Strongest on Instagram" /><MetricCard label="Clicks" value="1,247" detail="Website visits" /><MetricCard label="Conversions" value="84" detail="Provider attribution required" /></section><article className="pod-rich-card"><div className="pod-card-heading"><div><small>Channel trend</small><h3>Last 8 campaign days</h3></div><BarChart3 /></div><div className="pod-chart pod-chart-large">{[32, 46, 42, 60, 54, 76, 68, 88].map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}</div></article></div>;
      case 'team':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Collaborations</p><h2>People inside this pod</h2><p className="subtle">Invite-only workspace access. Database policies still enforce pod ownership and membership.</p></div><button className="button button-primary button-sm" type="button" onClick={() => setModal({ type: 'invite' })}><Plus size={15} /> Invite collaborator</button></header><article className="pod-team-row"><span>{session?.user?.email?.slice(0, 2).toUpperCase() || 'YO'}</span><div><strong>{session?.user?.email || 'You'}</strong><small>Owner · Full pod access</small></div><StatusPill tone="green">Active</StatusPill></article></div>;
      case 'launch':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Coming soon</p><h2>Launch page and email capture</h2><p className="subtle">Create a simple branded page inside this pod, then review it before publishing.</p></div><button className="button button-primary" type="button" onClick={() => setModal({ type: 'launch' })}><Sparkles size={16} /> Generate page draft</button></header><article className="pod-launch-preview"><span className="pod-launch-orbit"><Sparkles /></span><p className="eyebrow">Aurora Skincare</p><h2>Winter skin, restored.</h2><p>A calmer barrier ritual is almost here. Join the list for first access.</p><div><input aria-label="Preview email" placeholder="you@example.com" disabled /><button type="button" disabled>Notify me</button></div><small>Preview only · Email captures remain private to this pod</small></article></div>;
      case 'budget':
        return <div className="pod-panel-stack"><header className="pod-panel-heading"><div><p className="eyebrow">Budget & ads</p><h2>Plan a monthly budget</h2><p className="subtle">This is your saved budget plan, not permission to spend. Provider spend and revenue remain unavailable until connected.</p></div><StatusPill>Plan only</StatusPill></header><section className="pod-metric-grid"><MetricCard label="Saved planned budget" value={budget ? `${budgetCurrency} ${Number(budget.planned_budget).toFixed(2)}`.trim() : 'Not set'} detail="Monthly plan only" /><MetricCard label="Provider spend" value="Unavailable" detail="Provider connection required" /><MetricCard label="Provider revenue" value="Unavailable" detail="Attribution required" /><MetricCard label="ROAS" value="Unavailable" detail="Live provider data required" /></section><article className="pod-rich-card"><label className="pod-modal-field">Planned monthly budget {budgetCurrency && `(${budgetCurrency})`}<input type="number" min="0" step="0.01" value={plannedBudgetInput} disabled={Boolean(operationalMutation)} onChange={(event) => setPlannedBudgetInput(event.target.value)} /></label><label className="pod-modal-field">Budget notes<textarea value={budgetNotes} disabled={Boolean(operationalMutation)} onChange={(event) => setBudgetNotes(event.target.value)} rows={3} /></label><button className="button button-primary" type="button" disabled={Boolean(operationalMutation)} onClick={saveBudget}>Save budget plan</button></article><article className="pod-budget-recommendation"><span><CircleDollarSign /></span><div><small>{budgetRecommendation ? 'Planning recommendation' : 'Budget planning'}</small><h3>{budgetRecommendation || 'Review your planned budget before authorising spend.'}</h3><p>Approval records a plan-only decision. It does not change provider spend or authorise publishing.</p></div><div className="pod-action-row"><button className="button button-primary button-sm" type="button" disabled={Boolean(operationalMutation)} onClick={() => decideBudget('approved')}>Approve recommendation</button><button className="button button-ghost button-sm" type="button" disabled={Boolean(operationalMutation)} onClick={() => decideBudget('rejected')}>Reject</button></div></article>{budgetDecision !== 'pending' && <p className="pod-decision-note">Saved plan-only decision: <strong>{budgetDecision}</strong>. No provider spend changed.</p>}</div>;
      default:
        return null;
    }
  };

  return (
    <section className="pod-workspace">
      {(subscription?.tier || 'free') === 'free' && (
        <div className="pod-demo-banner" role="note">
          <Sparkles size={15} />
          <span>Your pod is built and ready. Upgrade to start posting — plans from $89/month.</span>
          <Link to="/pricing">View plans →</Link>
        </div>
      )}
      <Link to="/pods" className="pod-back-link">&larr; Pods</Link><header className="pod-workspace-topbar">
        <div className="pod-workspace-title"><span className="pod-brand-orb"><Sparkles size={18} /></span><div><p className="eyebrow">{pod.brand_name || pod.pod_type}</p><h1>{pod.pod_name}</h1></div></div>
        <div className="pod-workspace-actions"><StatusPill tone={directionApproved ? 'green' : 'gold'}>{directionApproved ? 'Direction approved' : 'AI brain ready'}</StatusPill><button className="pod-command-trigger" type="button" onClick={() => setPaletteOpen(true)}><Command size={15} /> Commands <kbd>Ctrl K</kbd></button></div>
      </header>
      <div className="pod-workspace-body">
        <aside className="pod-workspace-nav" aria-label="Pod sections">{TAB_GROUPS.map((group) => <div key={group.label}><p>{group.label}</p>{group.items.map(([key, label, Icon]) => <button key={key} className={activeTab === key ? 'active' : ''} type="button" onClick={() => setActiveTab(key)}><Icon size={16} /><span>{label}</span></button>)}</div>)}</aside>
        <main className="pod-workspace-panel">{renderPanel()}</main>
      </div>
      {notice && <div className="pod-toast" role="status"><Check size={16} />{notice}</div>}
      <PodCommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <PodModal open={modal?.type === 'override'} title="Teach this pod your direction" description="The AI will readjust its tone and future output, then ask you to approve again." onClose={() => { if (!directionOperation.current) setModal(null); }}><label className="pod-modal-field">What should change?<textarea rows={5} value={overrideText} disabled={Boolean(directionMutation) || contentGenerating} onChange={(event) => setOverrideText(event.target.value)} placeholder="For example: make the tone more direct and less luxurious…" /></label><div className="pod-action-row"><button className="button button-primary" type="button" disabled={!overrideText.trim() || Boolean(directionMutation) || contentGenerating} onClick={saveOverride}>{directionMutation === 'override' ? 'Saving direction…' : 'Save and readjust'}</button><button className="button button-ghost" type="button" disabled={Boolean(directionMutation) || contentGenerating} onClick={() => setModal(null)}>Cancel</button></div></PodModal>
      <PodModal open={modal?.type === 'connect'} title={`Connect ${modal?.platform?.name || 'account'}`} description="Account connection must use the platform's official authorisation screen." onClose={() => setModal(null)}><div className="pod-provider-message"><Globe2 /><div><strong>Provider setup is not live yet</strong><p>Dovroyn can already plan {modal?.platform?.name} content. Live sign-in needs the provider app ID, permissions, redirect URL, token encryption, and platform approval before this button can safely open OAuth.</p></div></div><button className="button button-ghost" type="button" onClick={() => setModal(null)}>Understood</button></PodModal>
      <PodModal open={modal?.type === 'missing-source'} title="Complete the pod inputs first" description={modal?.message || 'Add one primary source, one logo, and no more than five brand photos.'} onClose={() => setModal(null)}><button className="button button-primary" type="button" onClick={() => { setModal(null); setActiveTab('sources'); }}>Complete pod inputs</button></PodModal>
      <PodModal open={modal?.type === 'analysis-first'} title="Run the analysis first" description="Content must come from this pod's website, photos, and approved direction." onClose={() => setModal(null)}><button className="button button-primary" type="button" onClick={() => { setModal(null); setActiveTab('direction'); }}>Go to AI direction</button></PodModal>
      <PodModal open={modal?.type === 'approval-first'} title="Approve the direction first" description="This prevents the AI from filling the pod with content based on a direction you do not want." onClose={() => setModal(null)}><button className="button button-primary" type="button" onClick={() => { setModal(null); setActiveTab('direction'); }}>Review direction</button></PodModal>
      <PodModal open={modal?.type === 'content-first'} title="Generate content first" description="The calendar schedules approved platform-specific drafts." onClose={() => setModal(null)}><button className="button button-primary" type="button" onClick={() => { setModal(null); setActiveTab('content'); }}>Open social content</button></PodModal>
      <PodModal open={modal?.type === 'invite'} title="Invite a collaborator" description="Invitations will be sent only after private pod-membership policies and email delivery are enabled." onClose={() => setModal(null)}><label className="pod-modal-field">Email address<input type="email" placeholder="collaborator@example.com" /></label><button className="button button-primary" type="button" onClick={() => { setModal(null); showNotice('Invite saved as pending setup; no email was sent.'); }}>Save pending invite</button></PodModal>
      <PodModal open={modal?.type === 'launch'} title="Coming-soon draft created" description="The page stays private until publishing infrastructure and its address are configured." onClose={() => setModal(null)}><div className="pod-provider-message"><Mail /><div><strong>Draft ready inside this pod</strong><p>The page uses the approved brand direction and stores email captures separately from marketing content.</p></div></div><button className="button button-primary" type="button" onClick={() => { setModal(null); showNotice('Coming-soon page draft saved.'); }}>Save page draft</button></PodModal>
    </section>
  );
}
