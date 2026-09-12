import {
  Bot,
  Leaf,
  MapPin,
  Palette,
  Share2,
  Users,
} from 'lucide-react';
import { FaFacebookF, FaInstagram, FaPinterestP, FaTiktok } from 'react-icons/fa6';
import { Link } from 'react-router-dom';

const DASHBOARD_NAV_ITEMS = ['AI Brain', 'Content Calendar', 'Platforms', 'Files', 'Ad Performance', 'Budget'];

const PLATFORM_CHIPS = [
  { label: 'Instagram', Icon: FaInstagram },
  { label: 'Pinterest', Icon: FaPinterestP },
  { label: 'Facebook', Icon: FaFacebookF },
  { label: 'TikTok', Icon: FaTiktok },
];

const BRAND_SWATCHES = [
  { label: 'Sand', color: '#C8A97E' },
  { label: 'Eucalyptus Green', color: '#4A6B57' },
  { label: 'Terracotta', color: '#B35C3E' },
  { label: 'Charcoal', color: '#2E2E2E' },
];

const DASHBOARD_ROWS = [
  {
    icon: Palette,
    label: 'Brand Colours',
    detail: 'Core palette inspired by the Australian outback — ochre, eucalyptus, and rust tones for embroidered hats and apparel.',
    swatches: BRAND_SWATCHES,
  },
  {
    icon: Bot,
    label: 'Brand Tone',
    detail: 'Voice guidance for handcrafted premium product storytelling across campaigns.',
    chips: ['Authentic', 'Handcrafted', 'Australian', 'Timeless'],
  },
  {
    icon: Users,
    label: 'Target Audience',
    detail: 'Audience segments most likely to buy Australian-made embroidered headwear.',
    chips: ['Outdoor enthusiasts', 'Travellers', 'Gift buyers', 'Australian lifestyle lovers'],
  },
  {
    icon: MapPin,
    label: 'Geography',
    detail: 'Campaign recommendations prioritise markets with strong outdoor lifestyle demand.',
    chips: ['Australia', 'New Zealand', 'USA'],
  },
  {
    icon: Share2,
    label: 'Recommended Platforms',
    platforms: PLATFORM_CHIPS,
    detail: 'Best-fit mix for visual product discovery, storytelling, and short-form reach.',
  },
];

function TesterPodContent() {
  return (
    <div className="tester-pod-content-shell">
      <div className="tester-pod-dashboard-list">
        {DASHBOARD_ROWS.map((row) => {
          const RowIcon = row.icon;

          return (
            <div key={row.label} className="tester-pod-dashboard-row">
              <span className="tester-pod-row-icon" aria-hidden="true">
                <RowIcon size={14} strokeWidth={1.9} />
              </span>
              <div className="tester-pod-row-main">
                <span className="tester-pod-row-label">{row.label}</span>
                <p className="tester-pod-row-detail">{row.detail}</p>
              </div>
              <div className="tester-pod-row-values">
                {row.swatches && (
                  <span className="tester-pod-swatches" aria-label="Brand colour swatches">
                    {row.swatches.map((swatch) => (
                      <span key={swatch.label} className="tester-pod-swatch-item" title={swatch.label}>
                        <span
                          className="tester-pod-swatch"
                          style={{ background: swatch.color }}
                          aria-label={swatch.label}
                        />
                      </span>
                    ))}
                  </span>
                )}
                {row.chips && (
                  <span className="tester-pod-platforms" aria-label={`${row.label} values`}>
                    {row.chips.map((chip) => (
                      <span key={chip} className="tester-pod-platform-chip">
                        {chip}
                      </span>
                    ))}
                  </span>
                )}
                {row.platforms && (
                  <span className="tester-pod-platforms" aria-label="Recommended platforms">
                    {row.platforms.map(({ label, Icon }) => (
                      <span key={label} className="tester-pod-platform-chip">
                        <Icon aria-hidden="true" />
                        {label}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <Link className="tester-pod-row-action" to="/demo-pod">Try override</Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TesterPodHeader() {
  return (
    <div className="tester-pod-header">
      <div className="tester-pod-header-main">
        <span className="tester-pod-avatar" aria-hidden="true">
          <Leaf size={24} strokeWidth={1.85} />
        </span>
        <div>
          <p className="tester-pod-title">Gidgee Co</p>
          <p className="tester-pod-subtitle">Australian Hat Embroidery</p>
        </div>
      </div>
      <div className="tester-pod-controls" aria-label="Preview controls">
        <span className="tester-pod-status">AI Brain Active</span>
        <Link className="tester-pod-style-button" to="/demo-pod">Open demo pod ✦</Link>
      </div>
    </div>
  );
}

function TesterPodChrome({ children }) {
  return (
    <div className="tester-pod-card panel">
      {children}
    </div>
  );
}

function TesterPodTabs() {
  return (
    <div className="tester-pod-tabs" aria-label="Gidgee Co pod sections">
      {DASHBOARD_NAV_ITEMS.map((item, index) => (
        <span key={item} className={`tester-pod-tab ${index === 0 ? 'active' : ''}`}>
          {item}
        </span>
      ))}
    </div>
  );
}

function TesterPodPanel() {
  return (
    <section className="tester-pod-content-panel">
      <TesterPodContent />
    </section>
  );
}

function TesterPodMobileValues({ row }) {
  if (row.swatches) {
    return (
      <span className="tester-pod-mobile-swatches" aria-label="Brand colour swatches">
        {row.swatches.map((swatch) => (
          <span key={swatch.label} className="tester-pod-mobile-swatch-shell" title={swatch.label}>
            <span
              className="tester-pod-mobile-swatch"
              style={{ background: swatch.color }}
              aria-label={swatch.label}
            />
          </span>
        ))}
      </span>
    );
  }

  if (row.chips) {
    return (
      <span className="tester-pod-mobile-chips" aria-label={`${row.label} values`}>
        {row.chips.map((chip) => (
          <span key={chip} className="tester-pod-mobile-chip">
            {chip}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className="tester-pod-mobile-chips" aria-label="Recommended platforms">
      {row.platforms.map(({ label, Icon }) => (
        <span key={label} className="tester-pod-mobile-chip tester-pod-mobile-platform-chip">
          <Icon aria-hidden="true" />
          {label}
        </span>
      ))}
    </span>
  );
}

function TesterPodMobileDashboard() {
  return (
    <div className="tester-pod-mobile-card" aria-label="Gidgee Co compact mobile pod preview">
      <div className="tester-pod-mobile-header">
        <div className="tester-pod-mobile-brand">
          <span className="tester-pod-mobile-avatar" aria-hidden="true">
            <Leaf size={22} strokeWidth={1.85} />
          </span>
          <div>
            <p className="tester-pod-mobile-title">Gidgee Co</p>
            <p className="tester-pod-mobile-subtitle">Australian Hat Embroidery</p>
          </div>
        </div>
        <div className="tester-pod-mobile-actions" aria-label="Mobile preview controls">
          <span className="tester-pod-mobile-status">AI Brain Active</span>
          <Link className="tester-pod-mobile-ready" to="/demo-pod">Open demo pod ✦</Link>
        </div>
      </div>

      <div className="tester-pod-mobile-tabs" aria-label="Gidgee Co pod sections">
        {DASHBOARD_NAV_ITEMS.map((item, index) => (
          <span key={item} className={`tester-pod-mobile-tab ${index === 0 ? 'active' : ''}`}>
            {item}
          </span>
        ))}
      </div>

      <div className="tester-pod-mobile-rows">
        {DASHBOARD_ROWS.map((row) => {
          const RowIcon = row.icon;

          return (
            <div key={row.label} className="tester-pod-mobile-row">
              <div className="tester-pod-mobile-row-label-cell">
                <span className="tester-pod-mobile-row-icon" aria-hidden="true">
                  <RowIcon size={13} strokeWidth={1.9} />
                </span>
                <span>
                  <span className="tester-pod-mobile-row-label">{row.label}</span>
                  <span className="tester-pod-mobile-row-detail">{row.detail}</span>
                </span>
              </div>
              <div className="tester-pod-mobile-row-values">
                <TesterPodMobileValues row={row} />
              </div>
              <Link className="tester-pod-mobile-override" to="/demo-pod">Try override</Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TesterPodDashboard() {
  return (
    <>
      <div className="tester-pod-desktop-preview">
        <TesterPodChrome>
          <TesterPodHeader />
          <TesterPodTabs />
          <TesterPodPanel />
        </TesterPodChrome>
      </div>
      <TesterPodMobileDashboard />
    </>
  );
}

export default function TesterPodPreview() {
  return (
    <section className="tester-pod-section">
      <h2 className="section-title">See one of Dovroyn's AI pods.</h2>
      <p className="lede">
        This preview shows one dedicated Dovroyn AI pod after it has analysed a brand. Each pod has its own AI brain, brand memory, content calendar, platform strategy, ad view, files, and budget tracker.
      </p>

      <TesterPodDashboard />

      <div className="tester-pod-cta">
        <Link className="button button-primary" to="/signup">Create Your Account</Link>
        <p className="tester-pod-note">
          This is a preview. Live posting and ad actions require connected accounts and user approval.
        </p>
      </div>
    </section>
  );
}
