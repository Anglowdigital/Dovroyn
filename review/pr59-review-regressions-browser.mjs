// Controlled HTTP/store and Meta responses only. No real accounts, credentials or publishing.
// BASELINE=1 reproduces both findings on ec1ce60; otherwise verifies the repaired flow.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, transformWithOxc } from 'vite';
import sharp from 'sharp';
import { creativeReviewPayload, latestCreativeReview } from '../src/lib/creativeReview.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseline = process.env.BASELINE === '1';
const jpeg = `data:image/jpeg;base64,${(await sharp('public/demo/aurora-products.png').resize(32,32).jpeg().toBuffer()).toString('base64')}`;
const rows = [], calls = [];
let releaseDraft, releaseApproval, holdDraft = false, holdApproval = false, failDraft = false, format = 'object', serial = 0;
const tokens = new Map();
const addRow = value => {
  const row = { id: `fixture-${++serial}`, pod_id: 'review-pod', preference_type: 'creative_review', active: true, created_at: new Date(Date.UTC(2026,9,14,10,0,serial)).toISOString(), preference_value: format === 'json-string' ? JSON.stringify(value) : value };
  rows.push(row); return row;
};
const moduleCode = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import CreativeReview from '/src/components/pod/CreativeReview.jsx';
import '/src/index.css'; import '/src/visual-upgrade.css';
const seed = await (await fetch('/__seed?format='+new URLSearchParams(location.search).get('format'))).json();
function Fixture() {
 const [visible, setVisible] = useState(true), [preferences, setPreferences] = useState(seed);
 const unrelated = () => setPreferences(current => [...current, {id:'other-'+current.length,pod_id:'review-pod',preference_type:'creative_review',active:true,created_at:'2026-10-14T12:00:00Z',preference_value:JSON.stringify({post_id:'unrelated-post',status:'draft'})}]);
 return <><h1>CONTROLLED REVIEW RACE FIXTURE — simulated Meta, no live accounts</h1>
 <button onClick={()=>setVisible(!visible)}>{visible?'Hide editor':'Show editor'}</button><button onClick={unrelated}>Save unrelated fixture</button>
 {visible && <CreativeReview podId="review-pod" post={{id:'review-post',platformName:'Facebook',content:'Fixture caption',targetAccounts:[{provider:'facebook',providerAccountId:'fixture-account'}]}} brandName="Fixture" accessToken="fixture-only" canReviewExactMetaArtwork={true} savedPreferences={preferences} onSaved={row=>setPreferences(current=>[...current,row])} />}</>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const files = ['src/components/pod/CreativeReview.jsx','src/lib/creativeReview.js','src/lib/creativeDraft.js'];
const server = await createServer({ server: {host:'127.0.0.1',port:4181,strictPort:true}, plugins:[{
 name:'controlled-review-races',enforce:'pre',
 resolveId(id) {if(id==='/__race.jsx')return '\0race.jsx';},
 async load(id) {if(id==='\0race.jsx')return (await transformWithOxc(moduleCode,'race.jsx',{jsx:{runtime:'automatic'}})).code;},
 transform(code,id) {
  if(id.endsWith('/src/lib/supabaseClient.js'))return `import {createClient} from '@supabase/supabase-js';export const supabaseConfigured=true;export const supabase=createClient('http://127.0.0.1:4181','fixture-public-key',{auth:{persistSession:false,autoRefreshToken:false}});`;
  const path=files.find(path=>id.endsWith('/'+path));
  if(baseline && path)return execFileSync('git',['show','ec1ce6078be6292ae4d54fdf8c68ce32f7cc772c:'+path],{encoding:'utf8'});
 },
 configureServer(s) {s.middlewares.use(async(req,res,next)=>{
  const send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(req.url.startsWith('/__race?')) {res.setHeader('Content-Type','text/html');return res.end(await s.transformIndexHtml('/__race','<div id="root"></div><script type="module" src="/__race.jsx"></script>'));}
  if(req.url.startsWith('/__seed?')) {rows.length=0;calls.length=0;serial=0;format=new URL(req.url,'http://fixture').searchParams.get('format');return send([addRow(creativeReviewPayload('review-post','Fixture headline','Fixture CTA',null,false,'Fixture caption'))]);}
  if(req.url==='/__pending')return send({draft:Boolean(releaseDraft),approval:Boolean(releaseApproval)});
  if(req.method!=='POST')return next();
  if(!req.url.startsWith('/rest/v1/pod_preferences') && !req.url.startsWith('/api/integrations/meta/artwork/'))return next();
  let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);
  if(req.url.startsWith('/rest/')) {
   calls.push('draft-start');if(holdDraft){holdDraft=false;await new Promise(resolve=>{releaseDraft=resolve;});}
   if(failDraft){failDraft=false;calls.push('draft-failed');return send({message:'Controlled denied draft'},403);}
   assert.equal(input.pod_id,'review-pod');assert.equal(input.preference_value.status,'draft');
   const row=addRow(input.preference_value);calls.push('draft-end');return send(row,201);
  }
  if(req.url.endsWith('/prepare')) {
   calls.push('prepare');const token='fixture-token-'+tokens.size;tokens.set(token,{revision:rows.at(-1).id,input});
   return send({preparationToken:token,accountSnapshotFingerprint:'fixture-accounts',image:{dataUrl:jpeg,dimensions:{width:32,height:32}}});
  }
  if(req.url.endsWith('/approve')) {
   calls.push('approve-start');if(holdApproval){holdApproval=false;await new Promise(resolve=>{releaseApproval=resolve;});}
   const prepared=tokens.get(input.preparationToken);
   if(prepared?.revision!==rows.at(-1).id)return send({error:'Controlled stale review revision'},409);
   const value=creativeReviewPayload('review-post',prepared.input.headline,prepared.input.callToAction,null,true,'Fixture caption');
   const row=addRow(value);calls.push('approve-end');return send({approval:row,exports:[{fixture:true}]});
  }
 });}
}]});
await server.listen();
await mkdir('/tmp/dovroyn-pr59-review-browser',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try {
 for(const width of [1440,390]) for(const rowFormat of ['object','json-string']) {
  const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const prepare=()=>page.getByRole('button',{name:'Prepare exact JPEG',exact:true});
  const approve=()=>page.getByRole('button',{name:'Approve rendered JPEG',exact:true});
  const save=()=>page.getByRole('button',{name:'Save creative draft',exact:true});
  const mount=async()=>{await page.getByRole('button',{name:'Hide editor',exact:true}).click();await page.getByRole('button',{name:'Show editor',exact:true}).click();};
  const ready=async()=>{await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Approve rendered JPEG'&&!b.disabled));};
  await page.goto('http://127.0.0.1:4181/__race?format='+rowFormat,{waitUntil:'domcontentloaded'});
  await prepare().click();await ready();
  for(let repeat=0;repeat<3;repeat++)await page.getByRole('button',{name:'Save unrelated fixture',exact:true}).click();
  const exact=page.getByAltText('Exact rendered artwork for approval');
  if(baseline && rowFormat==='json-string') {await exact.waitFor({state:'detached'});console.log(`REPRODUCED unrelated string-row update discards JPEG (${width})`);}
  else {assert.equal(await exact.count(),1);assert.equal(await approve().isEnabled(),true);}
  // Interrupted draft must not land after a newer approval.
  for(let repeat=0;repeat<(baseline?1:2);repeat++) {
   holdDraft=true;releaseDraft=null;
   await save().click();await page.waitForFunction(async()=> (await (await fetch('/__pending')).json()).draft);
   await mount();
   if(baseline) {
    assert.equal(await prepare().isEnabled(),true);await prepare().click();await ready();await approve().click();await page.getByText('Approved creative',{exact:true}).waitFor();
    assert.equal(latestCreativeReview(rows,'review-pod','review-post').status,'approved');
    releaseDraft();await page.getByText('Draft saved',{exact:true}).waitFor();
    assert.equal(latestCreativeReview(rows,'review-pod','review-post').status,'draft');
    console.log(`REPRODUCED old draft supersedes newer approval (${rowFormat}, ${width})`);
   } else {
    assert.equal(await prepare().isDisabled(),true);assert.equal(await approve().isDisabled(),true);assert.equal(await save().isDisabled(),true);
    await page.screenshot({path:`/tmp/dovroyn-pr59-review-browser/pending-${width}-${rowFormat}.png`,fullPage:true});
    const prepares=calls.filter(call=>call==='prepare').length;
    releaseDraft();await page.getByText('Draft saved',{exact:true}).waitFor();
    assert.equal(calls.filter(call=>call==='prepare').length,prepares);
    await prepare().click();await ready();await approve().click();await page.getByText('Approved creative',{exact:true}).waitFor();
    assert.equal(latestCreativeReview(rows,'review-pod','review-post').status,'approved');
    assert.ok(calls.lastIndexOf('draft-end')<calls.lastIndexOf('approve-start'));
   }
  }
  if(!baseline) {
   // Reverse interruption: approval owns the shared operation until confirmed.
   await prepare().click();await ready();holdApproval=true;releaseApproval=null;
   await approve().click();await page.waitForFunction(async()=> (await (await fetch('/__pending')).json()).approval);await mount();
   assert.equal(await save().isDisabled(),true);assert.equal(await prepare().isDisabled(),true);
   releaseApproval();await page.getByText('Approved creative',{exact:true}).waitFor();
   await save().click();await page.getByText('Draft saved',{exact:true}).waitFor();
   // A failed prior write releases the operation and never fabricates approval.
   holdDraft=true;failDraft=true;releaseDraft=null;await save().click();await page.waitForFunction(async()=> (await (await fetch('/__pending')).json()).draft);await mount();
   assert.equal(await prepare().isDisabled(),true);releaseDraft();
   await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Prepare exact JPEG'&&!b.disabled));
   await prepare().click();await ready();await approve().click();await page.getByText('Approved creative',{exact:true}).waitFor();
   assert.equal(latestCreativeReview(rows,'review-pod','review-post').status,'approved');
  }
  if(!baseline)await page.screenshot({path:`/tmp/dovroyn-pr59-review-browser/confirmed-${width}-${rowFormat}.png`,fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log(baseline?'PASS: both reported findings reproduced on ec1ce60 using object/JSON-string rows.':'PASS: object/JSON-string rows, unrelated saves, repeated interrupted draft/approval, failure recovery, desktop/mobile; simulated Meta only.');
} finally {if(releaseDraft)releaseDraft();if(releaseApproval)releaseApproval();await browser.close();await server.close();}
