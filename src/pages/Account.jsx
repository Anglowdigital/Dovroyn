import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { supabase, supabaseConfigured } from '../lib/supabaseClient';
import CheckoutButton from '../components/CheckoutButton';
import { PLAN_ENTITLEMENTS, formatPlanPrice } from '../lib/plans.js';

// Descriptive details supplement the shared plan prices and allowances.
const TIER_DETAILS = {
  free: {
    seats: '1 seat',
    note: 'Build your pod free — subscribe to unlock campaign planning tools.',
  },
  starter: { seats: '1 seat', note: null },
  growth: {
    seats: '3 team seats',
    note: 'Extra campaign content-planning days available as add-ons.',
  },
  pro: { seats: '5 team seats', note: null },
  scale: { seats: 'Unlimited team seats', note: null },
};

const TIER_INFO = Object.fromEntries(Object.entries(PLAN_ENTITLEMENTS).map(([key, plan]) => [key, {
  label: plan.name,
  pods: key === 'free' ? '1 pod' : plan.maxPods === 1 ? '1 active pod' : `Up to ${plan.maxPods} active pods`,
  price: key === 'free' ? 'Free' : `${formatPlanPrice(key, 'monthly')}/month`,
  yearlyPrice: key === 'free' ? null : `${formatPlanPrice(key, 'yearly')}/year`,
  posting: plan.weeklyPostingDays ? `${plan.weeklyPostingDays} campaign content-planning days per week` : null,
  ...TIER_DETAILS[key],
}]));

function TierBadge({ tier, subscription }) {
  const info = TIER_INFO[tier] || TIER_INFO.free;
  return (
    <article className="panel detail-card" style={{ borderColor: 'var(--gold)' }}>
      <p className="eyebrow">Current plan</p>
      <h3 style={{ fontFamily: "'Playfair Display', serif", margin: '0.25rem 0 0.5rem' }}>
        {info.label}
      </h3>
      {info.yearlyPrice && <p className="subtle">Plan prices</p>}
      <p className="pricing-price" style={{ fontSize: '1.5rem', margin: '0.25rem 0' }}>
        {info.price}
      </p>
      {info.yearlyPrice && (
        <>
          <p className="subtle">or {info.yearlyPrice}</p>
          <p className="subtle">Subscription status: {(subscription?.status || 'unavailable').replaceAll('_', ' ')}</p>
        </>
      )}
      <ul className="simple-list" style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0 0' }}>
        <li style={{ padding: '0.25rem 0', color: 'var(--navy)' }}>✓ {info.pods}</li>
        {info.posting && (
          <li style={{ padding: '0.25rem 0', color: 'var(--navy)' }}>✓ {info.posting}</li>
        )}
        {info.seats && (
          <li style={{ padding: '0.25rem 0', color: 'var(--navy)' }}>✓ {info.seats}</li>
        )}
        {info.note && (
          <li style={{ padding: '0.25rem 0', color: 'var(--muted)', fontSize: '0.875rem' }}>
            {info.note}
          </li>
        )}
        <li style={{ padding: '0.25rem 0', color: 'var(--muted)', fontSize: '0.875rem' }}>
          Planning and drafts only. Direct social connections and publishing are not available yet.
        </li>
      </ul>
    </article>
  );
}

function UpgradeOptions({ currentTier, session }) {
  const tiers = [
    { key: 'starter', ...TIER_INFO.starter },
    { key: 'growth',  ...TIER_INFO.growth },
    { key: 'pro',     ...TIER_INFO.pro },
    { key: 'scale',   ...TIER_INFO.scale },
  ];

  const upgrades = tiers.filter((t) => {
    const order = ['free', 'starter', 'growth', 'pro', 'scale'];
    return order.indexOf(t.key) > order.indexOf(currentTier || 'free');
  });

  if (upgrades.length === 0) return null;

  return (
    <article className="panel detail-card">
      <p className="eyebrow">Upgrade your plan</p>
      <h4>Scale when you are ready.</h4>
      <p className="subtle" style={{ marginTop: '0.5rem' }}>
        Plan allowances cover drafts and calendar planning. Direct social connections and publishing are not available yet.
      </p>
      <div className="cards-grid" style={{ marginTop: '1rem' }}>
        {upgrades.map((t) => (
          <div key={t.key} className="panel" style={{ padding: '1rem' }}>
            <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{t.label}</p>
            <p style={{ color: 'var(--gold)', fontWeight: 700, marginBottom: '0.5rem' }}>
              {t.price}
            </p>
            <p className="subtle" style={{ marginBottom: '0.5rem' }}>{t.pods}</p>
            {t.posting && (
              <p className="subtle" style={{ marginBottom: '0.5rem' }}>{t.posting}</p>
            )}
            {t.seats && (
              <p className="subtle" style={{ marginBottom: '0.75rem' }}>{t.seats}</p>
            )}
            <CheckoutButton tier={t.key} billing="monthly" session={session}>
              Upgrade to {t.label}
            </CheckoutButton>
          </div>
        ))}
      </div>
    </article>
  );
}


function ProfileSection({ user }) {
  const [fullName, setFullName] = useState(user?.user_metadata?.full_name || '');
  const [company, setCompany] = useState(user?.user_metadata?.company || '');
  const [newEmail, setNewEmail] = useState(user?.email || '');
  const [status, setStatus] = useState('');

  const saveIdentity = async () => {
    if (!supabaseConfigured || !supabase) return;
    const { error } = await supabase.auth.updateUser({ data: { full_name: fullName.trim(), company: company.trim() } });
    setStatus(error ? error.message : 'Profile saved.');
  };
  const changeEmail = async () => {
    if (!supabaseConfigured || !supabase) return;
    const clean = newEmail.trim().toLowerCase();
    if (!clean || clean === user?.email) { setStatus('Enter a new email address to change it.'); return; }
    const { error } = await supabase.auth.updateUser({ email: clean });
    setStatus(error ? error.message : 'Confirmation sent to your new email address — click the link there to complete the change.');
  };

  return (
    <article className="panel detail-card">
      <p className="eyebrow">Profile</p>
      <div style={{ display: 'grid', gap: '0.6rem', marginTop: '0.5rem', maxWidth: '28rem' }}>
        <label>Name<input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" /></label>
        <label>Company (optional)<input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Your business name" /></label>
        <button className="button button-primary" type="button" onClick={saveIdentity}>Save profile</button>
        <div>
          <p className="subtle" style={{ fontSize: '0.8rem', marginBottom: '0.1rem' }}>Email</p>
          <p style={{ fontWeight: 500 }}>{user?.email || '—'}</p>
        </div>
        <label>Change email<input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="new@address.com" /></label>
        <button className="button button-ghost" type="button" onClick={changeEmail}>Change email</button>
        <div>
          <p className="subtle" style={{ fontSize: '0.8rem', marginBottom: '0.1rem' }}>User ID</p>
          <p style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--muted)' }}>{user?.id || '—'}</p>
        </div>
      </div>
      {status && <p className="subtle" style={{ marginTop: '0.6rem' }}>{status}</p>}
    </article>
  );
}

export default function AccountPage({ session, subscription }) {
  const user = session?.user;
  const tier = subscription?.tier || 'free';

  const handleSignOut = async () => {
    if (!supabaseConfigured || !supabase) return;
    await supabase.auth.signOut();
  };

  return (
    <div className="page-stack">
      <header className="section-header panel">
        <div>
          <p className="eyebrow">Account</p>
          <h3>Your Dovroyn account</h3>
          <p className="subtle">Manage your subscription, profile, and billing.</p>
        </div>
        <button className="button button-ghost" type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      {/* Profile */}
      <ProfileSection user={user} />

      {/* Subscription */}
      <TierBadge tier={tier} subscription={subscription} />

      {/* Upgrade options */}
      <UpgradeOptions currentTier={tier} session={session} />

      {/* Billing note */}
      {tier !== 'free' && (
        <article className="panel detail-card">
          <p className="eyebrow">Billing</p>
          <h4>Manage your subscription</h4>
          <p className="subtle" style={{ marginTop: '0.5rem' }}>
            To cancel, pause, or update payment details, please contact us at{' '}
            <a href="mailto:support@dovroyn.com" style={{ color: 'var(--gold)' }}>
              support@dovroyn.com
            </a>
            .
          </p>
        </article>
      )}

      {/* Quick links */}
      <article className="panel detail-card">
        <p className="eyebrow">Quick links</p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <NavLink className="button button-ghost" to="/pods">My Pods</NavLink>
          <NavLink className="button button-ghost" to="/pricing">Pricing</NavLink>
          <NavLink className="button button-ghost" to="/settings">Settings</NavLink>
        </div>
      </article>
    </div>
  );
}
