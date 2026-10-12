import * as Brand from 'react-icons/fa6';
import { SiGoogleads, SiBluesky, SiSubstack, SiNextdoor, SiApplenews } from 'react-icons/si';
import { FcGoogle } from 'react-icons/fc';
import { Mail, MessageSquare, Globe2 } from 'lucide-react';

// Brand glyphs retain their recognisable shapes and published brand colours.
// Owned channels deliberately use neutral utility icons, not invented logos.
const marks = {
  instagram: [Brand.FaInstagram, '#C13584'], facebook: [Brand.FaFacebook, '#0866FF'],
  tiktok: [Brand.FaTiktok, '#000000'], youtube: [Brand.FaYoutube, '#FF0000'],
  youtube_shorts: [Brand.FaYoutube, '#FF0000'], linkedin: [Brand.FaLinkedin, '#0A66C2'],
  x: [Brand.FaXTwitter, '#000000'], threads: [Brand.FaThreads, '#000000'],
  pinterest: [Brand.FaPinterest, '#E60023'], snapchat: [Brand.FaSnapchat, '#000000'],
  reddit: [Brand.FaRedditAlien, '#FF4500'], whatsapp: [Brand.FaWhatsapp, '#25D366'],
  telegram: [Brand.FaTelegram, '#26A5E4'], discord: [Brand.FaDiscord, '#5865F2'],
  wechat: [Brand.FaWeixin, '#07C160'], line: [Brand.FaLine, '#00C300'],
  tumblr: [Brand.FaTumblr, '#36465D'], mastodon: [Brand.FaMastodon, '#6364FF'],
  bluesky: [SiBluesky, '#0285FF'], twitch: [Brand.FaTwitch, '#9146FF'],
  spotify: [Brand.FaSpotify, '#1DB954'], apple_podcasts: [Brand.FaPodcast, '#9933CC'],
  substack: [SiSubstack, '#FF6719'], medium: [Brand.FaMedium, '#000000'],
  google_business: [FcGoogle, null], google_business_profile: [FcGoogle, null],
  nextdoor: [SiNextdoor, '#00843D'], google_ads: [SiGoogleads, '#4285F4'],
  meta_ads: [Brand.FaMeta, '#0866FF'], linkedin_ads: [Brand.FaLinkedin, '#0A66C2'],
  tiktok_ads: [Brand.FaTiktok, '#000000'], pinterest_ads: [Brand.FaPinterest, '#E60023'],
  amazon_ads: [Brand.FaAmazon, '#232F3E'], microsoft_ads: [Brand.FaMicrosoft, '#737373'],
  apple_news: [SiApplenews, '#FD415E'], email: [Mail, '#07162D'],
  sms: [MessageSquare, '#07162D'], blog: [Globe2, '#07162D'], website_blog: [Globe2, '#07162D'],
};

export default function PlatformMark({ platform, size = 22 }) {
  const key = platform === 'X / Twitter' ? 'x' : String(platform || '').toLowerCase().replaceAll(' ', '_');
  const [Icon, color] = marks[key] || [Globe2, '#07162D'];
  return <span className={`brand-platform-mark brand-platform-${key}`} aria-hidden="true" style={{ color }}><Icon size={size} /></span>;
}
