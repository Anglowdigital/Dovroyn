import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, ArrowRight } from 'lucide-react';
import PlatformMark from './PlatformMark';

export default function MarketingHero() {
  return <>
    <section className="editorial-hero" aria-labelledby="marketing-promise">
      <div className="editorial-hero-copy">
        <h1 id="marketing-promise">Your brand.<br />Its own AI <em>marketing pod.</em></h1>
        <p className="editorial-hero-tagline">Less blank page.<br />More <em>brand magic.</em></p>
        <p className="editorial-intro">Turn your website into a marketing powerhouse. Add it to a pod and let Dovroyn AI build your campaign.</p>
        <div className="editorial-actions">
          <Link className="button button-primary button-lg" to="/signup">Build my first pod <ArrowUpRight size={19} /></Link>
          <Link className="editorial-text-link" to="/demo-pod">Explore a demo pod <ArrowRight size={17} /></Link>
        </div>
        <p className="editorial-assurance"><Check size={15} /> Free AI analysis. No credit card required.</p>
      </div>
      <div className="campaign-scene" aria-label="Fictional Aurora Botanicals campaign preview">
        <article className="campaign-photo-card">
          <img src="/demo/aurora-products.png" alt="AI-created fictional Aurora Botanicals skincare bottles with eucalyptus on ivory stone" width="1024" height="1536" fetchPriority="high" />
          <div className="campaign-photo-caption"><span>THE WINTER RITUAL</span><strong>A little care.<br />A calmer everyday.</strong></div>
          <span className="campaign-example-label">Fictional demo creative</span>
        </article>
        <article className="campaign-direction-card">
          <span className="eyebrow">01 / The brand direction</span>
          <strong>Unmistakably Aurora.</strong>
          <p>Calm rituals. Botanical care.<br />A confident, considered voice.</p>
          <span className="campaign-sample-state"><Check size={13} /> Sample direction reviewed</span>
        </article>
        <article className="campaign-channel-card">
          <div><PlatformMark platform="instagram" /><span>Instagram <small>Sample draft · not published</small></span></div>
          <strong>Make room for your daily ritual.</strong>
          <p>One brand story. A voice for every channel.</p>
        </article>
      </div>
    </section>
    <section className="editorial-platform-strip" aria-label="Examples of platforms available for planning">
      <p>One direction.<br /><strong>Made for your channels.</strong></p>
      <div>{['Instagram', 'Facebook', 'TikTok', 'YouTube', 'LinkedIn', 'Pinterest'].map(name => <span key={name}><PlatformMark platform={name} size={25} /><span>{name}</span></span>)}</div>
      <small>Planning & drafts.<br />Connections depend on provider availability.</small>
    </section>
    <section className="editorial-workspace-intro">
      <div><p className="eyebrow">A home for every brand</p><h2>Your sources in.<br /><em>Your story comes together.</em></h2></div>
      <p>Start with the source. Review the AI analysis. Shape the direction before choosing channels and creating content. Explore the fictional pod below.</p>
    </section>
  </>;
}
