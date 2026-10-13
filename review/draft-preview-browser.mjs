// Controlled local fixtures only; never contacts owner accounts or production APIs.
// Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node review/draft-preview-browser.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, transformWithOxc } from 'vite';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = {
  pod: { id: 'fixture-pod', pod_name: 'CONTROLLED FIXTURE — no live accounts', brand_name: 'Fixture brand', source_type: 'photos' },
  posts: ['facebook', 'instagram', 'linkedin'].map(platform => ({ id: `fixture-${platform}`, platform, body: 'Fixture caption.', status: 'draft' })),
  assets: [{ id: 'fixture-upload', file_name: 'Controlled uploaded photo', storage_path: 'fixture/photo.jpg', asset_role: 'campaign_asset' }],
  preferences: [],
};
const fixtureModule = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PodWorkspace from '/src/pages/PodWorkspace.jsx';
import CreativeReview from '/src/components/pod/CreativeReview.jsx';
import '/src/index.css';
import '/src/visual-upgrade.css';
window.__workspace = ${JSON.stringify(fixture)};
const root = createRoot(document.getElementById('root'));
window.showEditor = (ready = true, content = 'Connected fixture caption.') => root.render(<><h1>CONTROLLED FIXTURE — simulated review, no live accounts</h1><CreativeReview podId="fixture-pod" post={{id:'fixture-post',platformName:'Facebook',content,targetAccounts:[{provider:'facebook',providerAccountId:'fixture-account'}]}} brandName="Fixture" canReviewExactMetaArtwork={ready} accessToken="fixture-only" /></>);
root.render(<MemoryRouter initialEntries={['/pods/fixture-pod']}><Routes><Route path="/pods/:podId" element={<PodWorkspace subscription={{tier:'free'}} />} /></Routes></MemoryRouter>);
`;
const server = await createServer({ server: { host: '127.0.0.1', port: 4179, strictPort: true }, plugins: [{
  name: 'controlled-draft-fixture', enforce: 'pre',
  resolveId(id) { if (id === '/__fixture.jsx') return '\0fixture.jsx'; },
  async load(id) { if (id === '\0fixture.jsx') return (await transformWithOxc(fixtureModule, 'fixture.jsx', { jsx: { runtime: 'automatic' } })).code; },
  transform(code, id) {
    if (process.env.BASELINE === '1' && id.endsWith('/src/pages/PodWorkspace.jsx')) return execFileSync('git', ['show', '28e3899422883ff54ada1159de9ed2488645c06d:src/pages/PodWorkspace.jsx'], { encoding: 'utf8' });
    if (id.endsWith('/src/lib/supabaseClient.js')) return 'export const supabaseConfigured = true; export const supabase = null;';
    if (id.endsWith('/src/lib/podRepository.js')) return code.replace('export async function loadPodWorkspace(', 'async function unusedLoadPodWorkspace(').replace('export async function getAssetPreview(', 'async function unusedGetAssetPreview(') + '\nexport async function loadPodWorkspace(){return window.__workspace;}\nexport async function getAssetPreview(){return "/demo/aurora-products.png";}';
  },
  configureServer(s) { s.middlewares.use((req, res, next) => { if (req.url !== '/__fixture') return next(); res.setHeader('Content-Type','text/html'); s.transformIndexHtml('/__fixture', '<div id="root"></div><script type="module" src="/__fixture.jsx"></script>').then(html => res.end(html)); }); },
}] });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
await mkdir('/tmp/dovroyn-browser', { recursive: true });
try {
  for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    let apiCalls = 0;
    await page.route('**/api/**', route => { apiCalls++; return route.abort(); });
    page.setDefaultTimeout(10000);
    await page.goto('http://127.0.0.1:4179/__fixture', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', {name:'Social content', exact:true}).click().catch(async error => {console.error(await page.locator('body').innerText()); throw error;});
    if (process.env.BASELINE === '1') {
      assert.equal(await page.getByLabel('Ad draft preview').count(), 0);
      await page.screenshot({path:`/tmp/dovroyn-browser/baseline-${viewport.width}.png`,fullPage:true});
      await page.close(); continue;
    }
    await page.getByLabel('Ad draft preview').first().waitFor();
    assert.equal(await page.getByLabel('Ad draft preview').count(), 3);
    for (const studio of await page.locator('.creative-review').all()) {
      await studio.getByLabel('Headline', {exact:true}).fill('Edited fixture headline');
      await studio.getByLabel('Call to action', {exact:true}).fill('Inspect fixture');
      assert.match(await studio.locator('.creative-ad').innerText(), /Edited fixture headline/);
      assert.equal(await studio.getByRole('button',{name:'Prepare exact JPEG'}).isDisabled(), true);
      assert.equal(await studio.getByRole('button',{name:'Approve rendered JPEG'}).isDisabled(), true);
      assert.equal(await studio.locator('.creative-ad-image').count(), 1);
      await studio.getByLabel('Creative image',{exact:true}).selectOption('');
      assert.equal(await studio.locator('.creative-ad-image').count(), 0);
      await studio.getByLabel('Creative image',{exact:true}).selectOption({ label: 'Controlled uploaded photo' });
      await studio.locator('.creative-ad-image').evaluate(img => img.decode());
      assert.ok(await studio.locator('.creative-ad-image').evaluate(img => img.naturalWidth > 0));
    }
    assert.equal(apiCalls, 0);
    await page.screenshot({path:`/tmp/dovroyn-browser/disconnected-${viewport.width}.png`,fullPage:true});
    assert.deepEqual(errors, []);
    await page.close();
  }
  if (process.env.BASELINE === '1') { console.log('PASS: production baseline reproduces missing draft editor at desktop/mobile.'); } else {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
    await page.goto('http://127.0.0.1:4179/__fixture', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.showEditor);
  let prepares = 0, approvals = 0;
  // Real JPEG bytes from a local generated canvas; API response is explicitly simulated.
  const jpeg = await page.evaluate(() => { const c=document.createElement('canvas'); c.width=32;c.height=32;return c.toDataURL('image/jpeg'); });
  await page.route('**/api/**', async route => {
    if (route.request().url().endsWith('/prepare')) { prepares++; return route.fulfill({json:{preparationToken:'fixture-token',accountSnapshotFingerprint:'fixture-snapshot',image:{dataUrl:jpeg,dimensions:{width:32,height:32}}}}); }
    if (route.request().url().endsWith('/approve')) { approvals++; return route.fulfill({json:{approval:{id:'fixture-approval'},exports:[{fixture:true}]}}); }
    throw new Error('Unexpected API call');
  });
  await page.evaluate(() => window.showEditor(true));
  await page.getByRole('button',{name:'Prepare exact JPEG'}).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b=>b.textContent==='Approve rendered JPEG').disabled);
  await page.getByLabel('Headline',{exact:true}).fill('Changed fixture headline');
  assert.equal(await page.getByRole('button',{name:'Approve rendered JPEG'}).isDisabled(),true);
  await page.getByRole('button',{name:'Prepare exact JPEG'}).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b=>b.textContent==='Approve rendered JPEG').disabled);
  await page.evaluate(() => window.showEditor(false));
  assert.equal(await page.getByRole('button',{name:'Approve rendered JPEG'}).isDisabled(),true);
  await page.evaluate(() => window.showEditor(true));
  await page.getByRole('button',{name:'Prepare exact JPEG'}).click();
  await page.getByRole('button',{name:'Approve rendered JPEG'}).click();
  await page.getByText('Approved creative',{exact:true}).waitFor();
  assert.equal(prepares,3); assert.equal(approvals,1);
  await page.screenshot({path:'/tmp/dovroyn-browser/connected-fixture.png',fullPage:true});
  console.log('PASS: real workspace disconnected preview/editing at desktop/mobile; connected simulated exact review; edit and readiness invalidation. No live owner acceptance.');
}
} finally { await browser.close(); await server.close(); }
