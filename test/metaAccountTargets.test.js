import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as meta from '../src/lib/metaOrganic.js';
import { persistPostTargetSnapshots } from '../src/lib/podState.js';

const discovery = { provider: 'instagram', providerAccountId: '201', accountConnectionId: 'discovery-id', accountLabel: 'Synthetic IG', connectionIntent: 'discovery' };
const publishing = { ...discovery, accountConnectionId: 'publishing-id', connectionIntent: 'publish' };
const publishingTarget = { provider: 'instagram', providerAccountId: '201', accountConnectionId: 'publishing-id', accountLabel: 'Synthetic IG' };

function currentTargets(accounts, selected) {
  const source = readFileSync(new URL('../src/pages/PodWorkspace.jsx', import.meta.url), 'utf8');
  const expression = source.match(/const currentTargetsFor = ([\s\S]*?);\n  const targetIsCurrent/)[1];
  const fn = new Function('connectedAccountsFor', 'selectedTargetsFor', 'resolveMetaAccountTargets', 'return (' + expression + ');')(
    () => accounts, () => selected, meta.resolveMetaAccountTargets);
  return fn('instagram');
}

test('workspace exact saved discovery and publishing IDs are independent of connection order', () => {
  for (const accounts of [[discovery,publishing],[publishing,discovery]]) {
    assert.equal(currentTargets(accounts, [discovery])[0]?.accountConnectionId, 'discovery-id');
    assert.equal(currentTargets(accounts, [publishing])[0]?.accountConnectionId, 'publishing-id');
  }
});

test('legacy account target ambiguity fails closed instead of choosing a publishing credential', () => {
  const legacy = { provider: 'instagram', providerAccountId: '201', accountLabel: 'Synthetic IG' };
  for (const accounts of [[discovery,publishing],[publishing,discovery]]) {
    assert.deepEqual(currentTargets(accounts, [legacy]), []);
  }
  assert.equal(currentTargets([discovery], [legacy])[0]?.accountConnectionId, 'discovery-id');
  assert.deepEqual(currentTargets([publishing], [legacy]), []);
});

test('missing or mismatched exact connection does not fall back to another same-account credential', () => {
  assert.deepEqual(currentTargets([publishing], [discovery]), []);
  assert.deepEqual(currentTargets([discovery,publishing], [{ ...discovery, providerAccountId: '999' }]), []);
});

test('checkbox and save identity distinguish the two connections and retain the chosen publishing ID', () => {
  for (const accounts of [[discovery,publishing],[publishing,discovery]]) {
    const selected = meta.toggleMetaAccountTarget?.([discovery], accounts, 'publishing-id', true);
    assert.deepEqual(selected, [publishingTarget]);
    assert.deepEqual(meta.toggleMetaAccountTarget?.([discovery], accounts, 'publishing-id', false), [discovery]);
    assert.deepEqual(meta.toggleMetaAccountTarget?.([publishing], accounts, 'publishing-id', false), []);
  }
  assert.notEqual(meta.metaAccountTargetKey?.(discovery), meta.metaAccountTargetKey?.(publishing));
  assert.equal(meta.metaAccountChoiceLabel?.(publishing, true), 'Synthetic IG · Publishing access');
  assert.equal(meta.metaAccountChoiceLabel?.(discovery, true), 'Synthetic IG · Account discovery');
  assert.equal(meta.metaAccountChoiceLabel?.(discovery), 'Synthetic IG');
});

test('snapshot write confirmation rejects a different connection ID with the same platform account and label', async () => {
  let inserted;
  const client = { from() { return { insert(rows) {
    inserted = rows;
    return { select: async () => ({ data: rows.map(row => ({
      ...row, preference_value: { ...row.preference_value,
        targets: row.preference_value.targets.map(target => ({ ...target, accountConnectionId: 'publishing-id' })) },
    })), error: null }) };
  } }; } };
  await assert.rejects(() => persistPostTargetSnapshots(client, 'synthetic-pod', [{
    postId: 'synthetic-post', platform: 'instagram', targets: [discovery],
  }]), /mismatched|incomplete/i);
  assert.equal(inserted[0].preference_value.targets[0].accountConnectionId, 'discovery-id');
});

test('saving an unknown connection is rejected and unchecking the single legacy discovery remains compatible', () => {
  assert.throws(() => meta.toggleMetaAccountTarget([], [discovery,publishing], 'unknown-id', true), /current account connection/i);
  assert.throws(() => meta.toggleMetaAccountTarget([], [discovery,publishing], '201', true), /current account connection/i);
  const legacy = { provider: 'instagram', providerAccountId: '201', accountLabel: 'Synthetic IG' };
  assert.deepEqual(meta.toggleMetaAccountTarget([legacy], [discovery], 'discovery-id', false), []);
});

test('workspace snapshot confirmation also rejects a substituted same-account connection ID', () => {
  const source = readFileSync(new URL('../src/pages/PodWorkspace.jsx', import.meta.url), 'utf8');
  const keyExpression = source.match(/const targetKey = ([\s\S]*?);\n\nfunction preferenceValue/)[1];
  const targetKey = new Function('return (' + keyExpression + ');')();
  const body = source.slice(source.indexOf('function confirmPostTargetSnapshots('), source.indexOf('function CompetitorSnapshotCards('));
  const confirm = new Function('targetKey', 'preferenceValue', body + '; return confirmPostTargetSnapshots;')(targetKey, value => value);
  assert.throws(() => confirm([{ postId: 'synthetic-post', platform: 'instagram', targets: [discovery] }], [{
    pod_id: 'synthetic-pod', preference_type: 'social_post_target_snapshot', active: true,
    preference_value: { postId: 'synthetic-post', platform: 'instagram', targets: [publishing] },
  }], 'synthetic-pod'), /mismatched|incomplete/i);
});
