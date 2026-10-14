import PlatformMark from './PlatformMark';
import './platform-marquee.css';

const platforms = ['Instagram', 'Facebook', 'TikTok', 'YouTube', 'LinkedIn', 'Pinterest'];

export default function PlatformMarquee() {
  return <section className="platform-marquee" tabIndex={0} aria-label="Examples of platforms available for planning">
    <div className="platform-marquee-heading">
      <p>Your pod. <strong>Your platforms.</strong></p>
    </div>
    <div className="platform-marquee-viewport">
      <div className="platform-marquee-track">
        {[false, true].map(duplicate => <ul className="platform-marquee-group" key={String(duplicate)} aria-hidden={duplicate ? 'true' : undefined}>
          {platforms.map(name => <li key={name}><PlatformMark platform={name} size={46} /><span className="platform-marquee-name">{name}</span></li>)}
        </ul>)}
      </div>
    </div>
    <p className="platform-marquee-note">Planning &amp; drafts. Connections depend on provider availability.</p>
  </section>;
}
