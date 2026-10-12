import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import BrandLogo from './BrandLogo';

export default function DovroynAdExamples() {
  return <section className="dovroyn-ad-examples" aria-labelledby="ad-examples-heading">
    <div className="editorial-workspace-intro"><div><p className="eyebrow">From direction to creative</p><h2 id="ad-examples-heading">A bigger idea.<br /><em>A clearer first impression.</em></h2></div><p>Original Dovroyn campaign concepts. A brand-first headline, a visual story, and one clear next step. Preview concepts only — no ads are running.</p></div>
    <div className="dovroyn-ad-grid">
      <article className="dovroyn-promo-ad" aria-label="Dovroyn brand campaign concept">
        <BrandLogo />
        <p className="promo-kicker">AI MARKETING. YOUR WAY.</p>
        <h3>Your next campaign<br />starts with <em>your brand.</em></h3>
        <p className="promo-description">One website. One dedicated AI pod.<br />A clearer direction for what comes next.</p>
        <div className="promo-product-previews"><div className="promo-media-story"><img src="/demo/aurora-products.png" alt="Fictional Aurora product imagery demonstrating a brand-led creative" /><span>Fictional demo creative</span><strong>A little ritual.<br />A brighter day.</strong></div><img src="/demo/pod-source-preview.png" alt="Actual Dovroyn source review interface with fictional demonstration assets" /></div>
        <footer><span>Start with free AI analysis <ArrowUpRight size={18} /></span><strong>dovroyn.com</strong></footer>
        <small>Campaign concept · Interface shown with fictional demo data</small>
      </article>
      <article className="dovroyn-promo-ad promo-ad-gold" aria-label="Dovroyn source-to-strategy campaign concept">
        <BrandLogo />
        <p className="promo-kicker">LESS GUESSWORK. MORE DIRECTION.</p>
        <h3>You know your brand.<br /><em>Give your AI a place<br />to learn it.</em></h3>
        <p className="promo-description">Bring your website or photos.<br />Review the analysis. Make the direction yours.</p>
        <div className="promo-editorial-steps"><span>01 <strong>Your source</strong></span><span>02 <strong>Your analysis</strong></span><span>03 <strong>Your direction</strong></span></div>
        <footer><span>Build your first pod <ArrowUpRight size={18} /></span><strong>dovroyn.com</strong></footer>
        <small>Original Dovroyn campaign concept · No performance claims</small>
      </article>
    </div>
    <Link className="editorial-text-link" to="/signup">Start with your own brand <ArrowUpRight size={17} /></Link>
  </section>;
}
