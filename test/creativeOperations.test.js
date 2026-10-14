import test from 'node:test';
import assert from 'node:assert/strict';
import { runCreativeOperation, isCreativeOperationPending, subscribeCreativeOperations } from '../src/lib/creativeOperations.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('one post orders draft, preparation and approval while other pods/posts proceed', async () => {
  const calls = [], changes = [];
  const unsubscribe = subscribeCreativeOperations(() => changes.push(isCreativeOperationPending('pod','post')));
  let release;
  const draft = runCreativeOperation('pod','post', async () => { calls.push('draft-start'); await new Promise(resolve => { release=resolve; }); calls.push('draft-end'); });
  const prepare = runCreativeOperation('pod','post', async () => { calls.push('prepare'); });
  const approve = runCreativeOperation('pod','post', async () => { calls.push('approve'); });
  assert.equal(isCreativeOperationPending('pod','post'),true);
  await Promise.all([
    runCreativeOperation('other-pod','post', async () => { calls.push('other-pod'); }),
    runCreativeOperation('pod','other-post', async () => { calls.push('other-post'); }),
  ]);
  assert.equal(calls.includes('prepare'),false);
  assert.equal(calls.includes('approve'),false);
  release();await Promise.all([draft,prepare,approve]);unsubscribe();
  assert.ok(calls.indexOf('draft-end')<calls.indexOf('prepare'));
  assert.ok(calls.indexOf('prepare')<calls.indexOf('approve'));
  assert.equal(isCreativeOperationPending('pod','post'),false);
  assert.equal(changes.at(-1),false);
});

test('failure releases pending state and a queued newer operation can proceed', async () => {
  let reject;
  const failed = runCreativeOperation('failure-pod','post', () => new Promise((_resolve,fail)=>{reject=fail;}));
  const rejection = assert.rejects(failed,/controlled failure/);
  const next = runCreativeOperation('failure-pod','post',async()=> 'fresh operation');
  await tick();reject(new Error('controlled failure'));
  await rejection;assert.equal(await next,'fresh operation');
  assert.equal(isCreativeOperationPending('failure-pod','post'),false);
});
