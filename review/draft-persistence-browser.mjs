// Controlled HTTP persistence fixture, never production or owner-account acceptance.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node review/draft-persistence-browser.mjs
import assert from 'node:assert/strict';
import { createServer, transformWithOxc } from 'vite';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const rows = [], writes = [];
let holdNextSave = false, releaseSave;
const workspace = podId => ({
  pod: { id: podId, pod_name: `CONTROLLED HTTP STORE FIXTURE — ${podId}`, brand_name: 'Fixture brand', source_type: 'photos' },
  posts: [{ id: 'fixture-post', platform: 'linkedin', body: `Caption for ${podId}`, status: 'draft' }],
  assets: [{ id: 'fixture-upload', file_name: 'Controlled uploaded photo', storage_path: `${podId}/photo.jpg`, asset_role: 'campaign_asset' }],
  preferences: rows.filter(row => row.pod_id === podId),
});
const fixtureModule = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import PodWorkspace from '/src/pages/PodWorkspace.jsx';
import '/src/index.css'; import '/src/visual-upgrade.css';
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/pods/fixture-a']}><nav aria-label="Fixture pods"><Link to="/pods/fixture-a">Fixture A</Link><Link to="/pods/fixture-b">Fixture B</Link></nav><Routes><Route path="/pods/:podId" element={<PodWorkspace subscription={{tier:'free'}} />} /></Routes></MemoryRouter>);
`;
const server = await createServer({ server: { host: '127.0.0.1', port: 4180, strictPort: true }, plugins: [{
  name: 'controlled-http-draft-store', enforce: 'pre',
  resolveId(id) { if (id === '/__persistence.jsx') return '\0persistence.jsx'; },
  async load(id) { if (id === '\0persistence.jsx') return (await transformWithOxc(fixtureModule, 'persistence.jsx', {jsx:{runtime:'automatic'}})).code; },
  transform(code, id) {
    if (id.endsWith('/src/lib/supabaseClient.js')) return `import { createClient } from '@supabase/supabase-js'; export const supabaseConfigured = true; export const supabase = createClient('http://127.0.0.1:4180', 'fixture-public-key', {auth:{persistSession:false,autoRefreshToken:false}});`;
    if (id.endsWith('/src/lib/podRepository.js')) return code.replace('export async function loadPodWorkspace(', 'async function unusedLoadPodWorkspace(').replace('export async function getAssetPreview(', 'async function unusedGetAssetPreview(') + '\nexport async function loadPodWorkspace(podId){return (await fetch("/__workspace?pod="+encodeURIComponent(podId))).json();}\nexport async function getAssetPreview(){return "/demo/aurora-products.png";}';
  },
  configureServer(s) { s.middlewares.use(async (req, res, next) => {
    if (req.url === '/__persistence') {
      res.setHeader('Content-Type','text/html');
      return res.end(await s.transformIndexHtml('/__persistence','<div id="root"></div><script type="module" src="/__persistence.jsx"></script>'));
    }
    if (req.url.startsWith('/__workspace?')) {
      res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(workspace(new URL(req.url,'http://fixture').searchParams.get('pod'))));
    }
    if (req.url.startsWith('/rest/v1/pod_preferences') && req.method === 'POST') {
      let body=''; for await (const chunk of req) body+=chunk;
      const payload=JSON.parse(body); writes.push(payload);
      assert.ok(['fixture-a','fixture-b'].includes(payload.pod_id));
      assert.equal(payload.preference_type,'creative_review');
      assert.equal(payload.preference_value.status,'draft');
      assert.equal(payload.preference_value.approved_at,null);
      if (holdNextSave) { holdNextSave=false; await new Promise(resolve=>{releaseSave=resolve;}); }
      const row={id:`fixture-revision-${rows.length+1}`,created_at:new Date().toISOString(),...payload}; rows.push(row);
      res.statusCode=201;res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(row));
    }
    next();
  }); },
}] });
await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
await mkdir('/tmp/dovroyn-draft-browser',{recursive:true});
try {
  for(const width of [1440,390]) {
    rows.length=0;writes.length=0;
    const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let prohibitedCalls=0;await page.route('**/api/**',route=>{prohibitedCalls++;return route.abort();});
    const openContent=async()=>{await page.getByRole('button',{name:'Social content',exact:true}).click();await page.getByLabel('Headline',{exact:true}).waitFor();};
    await page.goto('http://127.0.0.1:4180/__persistence',{waitUntil:'domcontentloaded'});await openContent();
    await page.getByLabel('Headline',{exact:true}).fill('Persisted fixture headline');
    await page.getByLabel('Call to action',{exact:true}).fill('Persisted CTA');
    await page.getByLabel('Creative image',{exact:true}).selectOption('');
    await page.getByRole('button',{name:'Save creative draft',exact:true}).click();
    await page.getByText('Draft saved',{exact:true}).waitFor();
    assert.equal(writes.length,1);
    await page.getByRole('button',{name:'Assets',exact:true}).click();await openContent();
    assert.equal(await page.getByLabel('Headline',{exact:true}).inputValue(),'Persisted fixture headline');
    assert.equal(await page.getByLabel('Call to action',{exact:true}).inputValue(),'Persisted CTA');
    assert.equal(await page.getByLabel('Creative image',{exact:true}).inputValue(),'');
    await page.getByLabel('Creative image',{exact:true}).selectOption({label:'Controlled uploaded photo'});
    await page.getByRole('button',{name:'Save creative draft',exact:true}).click();await page.getByText('Draft saved',{exact:true}).waitFor();
    await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});
    await page.reload({waitUntil:'domcontentloaded'});await openContent();
    assert.equal(await page.getByLabel('Headline',{exact:true}).inputValue(),'Persisted fixture headline');
    assert.equal(await page.getByLabel('Call to action',{exact:true}).inputValue(),'Persisted CTA');
    assert.equal(await page.getByLabel('Creative image',{exact:true}).inputValue(),'upload:fixture-a/photo.jpg');
    await page.locator('.creative-ad-image').evaluate(img=>img.decode());
    assert.equal(await page.getByRole('button',{name:'Prepare exact JPEG',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Approve rendered JPEG',exact:true}).isDisabled(),true);
    // A save finishing while another workspace tab is open must update parent memory.
    holdNextSave=true;
    await page.getByLabel('Headline',{exact:true}).fill('Saved while calendar open');
    await page.getByRole('button',{name:'Save creative draft',exact:true}).click();
    await page.getByRole('button',{name:'Saving draft…',exact:true}).waitFor();
    await page.getByRole('button',{name:'Calendar',exact:true}).click();
    await openContent(); // Remount before the old request completes.
    const tabSave=page.waitForResponse(response=>response.url().includes('/rest/v1/pod_preferences'));
    assert.ok(releaseSave);releaseSave();await tabSave;
    await openContent();
    await page.waitForFunction(()=>document.querySelector('.creative-review textarea')?.value==='Saved while calendar open');
    await page.getByText('Draft saved',{exact:true}).waitFor();
    // Hold a real draft POST while switching pods; its completion belongs only to A.
    holdNextSave=true;
    await page.getByLabel('Headline',{exact:true}).fill('Delayed fixture A headline');
    await page.getByRole('button',{name:'Save creative draft',exact:true}).click();
    await page.getByRole('button',{name:'Saving draft…',exact:true}).waitFor();
    await page.getByRole('link',{name:'Fixture B',exact:true}).click();await openContent();
    assert.equal(await page.getByLabel('Headline',{exact:true}).inputValue(),'Caption for fixture-b');
    await page.getByLabel('Headline',{exact:true}).fill('Independent fixture B');
    await page.getByRole('button',{name:'Save creative draft',exact:true}).click();await page.getByText('Draft saved',{exact:true}).waitFor();
    const podSave=page.waitForResponse(response=>response.url().includes('/rest/v1/pod_preferences') && response.request().postDataJSON().pod_id==='fixture-a');
    assert.ok(releaseSave);releaseSave();await podSave;
    assert.equal(await page.getByLabel('Headline',{exact:true}).inputValue(),'Independent fixture B');
    await page.getByRole('link',{name:'Fixture A',exact:true}).click();await openContent();
    assert.equal(await page.getByLabel('Headline',{exact:true}).inputValue(),'Delayed fixture A headline');
    assert.equal(await page.getByLabel('Call to action',{exact:true}).inputValue(),'Persisted CTA');
    assert.equal(await page.getByLabel('Creative image',{exact:true}).inputValue(),'upload:fixture-a/photo.jpg');
    assert.equal(prohibitedCalls,0);assert.deepEqual(errors,[]);
    await page.screenshot({path:`/tmp/dovroyn-draft-browser/restored-${width}.png`,fullPage:true});
    await page.close();
  }
  console.log('PASS: controlled HTTP save, tab navigation, browser reload after clearing local storage, stable image/CTA/headline restoration, delayed cross-pod save isolation; desktop/mobile. Zero Meta/publishing API calls.');
} finally {await browser.close();await server.close();}
