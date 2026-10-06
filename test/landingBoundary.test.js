import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const landing = source.split('function LandingPage(')[1].split('function DemoPodPage(')[0];

// The current Node suite has no JSX/DOM harness. These named source boundaries
// guard public marketing contracts; browser checks verify the rendered page.
test('public hero cannot regress to a different headline or omit a primary launch route', () => {
  assert.match(landing, /<h1>EVERY BRAND GETS ITS OWN AI BRAIN<\/h1>/);
  const hero = landing.split('<div className="hero-actions">')[1].split('</div>')[0];
  for (const route of ['/signup', '/demo-pod', '/pricing']) {
    assert.ok(hero.includes('to="' + route + '"'), 'missing primary route ' + route);
  }
});

test('public marketing cannot fabricate customer proof or misstate plan count', () => {
  assert.doesNotMatch(source, /TESTIMONIALS|★★★★★|Sarah K\.|Marcus T\.|Jessica L\.|3\.2x engagement|Zero off-brand posts|Trusted by Founders/);
  assert.doesNotMatch(landing, /Four tiers/);
  assert.match(landing, /Product principles/);
});

test('public assistant cannot regain live API calls or present prepared examples as live AI', () => {
  const assistant = readFileSync(new URL('../src/components/AiPodAssistant.jsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/lib/aiClient.js', import.meta.url), 'utf8');
  assert.doesNotMatch(assistant, /askLandingAssistant|fetch\s*\(|supabase|<form\b|<input\b|Online|live server-side assistant/);
  assert.match(assistant, /Prepared local examples/);
  assert.doesNotMatch(client, /askLandingAssistant|['"]\/api\/ai\/chat['"]/);
  assert.match(client, /['"]\/api\/ai\/pod-chat['"]/);
});

test('static ecosystem cards cannot claim connected accounts or masquerade as real customer pods', () => {
  const ecosystem = landing.split('<section className="multipod-preview">')[1]?.split('</section>')[0] || '';
  assert.ok(ecosystem, 'missing ecosystem section');
  assert.equal(/connected platforms/i.test(ecosystem), false, 'static ecosystem still claims connected platforms');
  assert.match(ecosystem, /aria-label={`\$\{pod.name\} sample recommended platforms:/);
  assert.match(ecosystem, /Illustrative ecosystem/);
  assert.match(ecosystem, /fictional sample pods/i);
});
