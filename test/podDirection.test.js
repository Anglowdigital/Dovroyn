import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPodDirectionApprovalCurrent,
  persistPodDirectionApproval,
  persistPodDirectionOverride,
  restorePodDirection,
} from '../src/lib/podDirection.js';

const originalAnalysis = { tone: 'Calm and luxurious', opportunity: 'Explain the product', audience: 'Local shoppers' };

function fakeClient({ failTable, noPod = false, beforeWrite = async () => {} } = {}) {
  const state = {
    pods: [{ id: 'pod-one', status: 'active', accepted_tone: 'Old tone', accepted_strategy: 'Old strategy' }, { id: 'pod-two', status: 'active' }],
    preferences: [],
    writes: [],
  };
  return {
    state,
    from(table) {
      let action;
      let values;
      let filter;
      const query = {
        update(row) { action = 'update'; values = row; return query; },
        insert(row) { action = 'insert'; values = row; return query; },
        eq(key, value) { filter = [key, value]; return query; },
        select() { return query; },
        async single() {
          await beforeWrite({ table, action, values, state });
          state.writes.push({ table, action, values });
          if (table === failTable) return { data: null, error: new Error(`${table} write rejected`) };
          if (table === 'pods') {
            const pod = !noPod && state.pods.find((row) => row[filter[0]] === filter[1]);
            if (!pod) return { data: null, error: null };
            Object.assign(pod, values);
            return { data: { ...pod }, error: null };
          }
          assert.equal(table, 'pod_preferences');
          const row = { id: `preference-${state.preferences.length}`, created_at: new Date().toISOString(), ...values };
          state.preferences.push(row);
          return { data: row, error: null };
        },
      };
      return query;
    },
  };
}

test('approval resolves only after a confirmed write to the selected pod', async () => {
  let releaseWrite;
  const waiting = new Promise((resolve) => { releaseWrite = resolve; });
  const client = fakeClient({ beforeWrite: () => waiting });
  let resolved = false;
  const approval = persistPodDirectionApproval(client, 'pod-one', originalAnalysis).then((pod) => { resolved = true; return pod; });
  await Promise.resolve();
  assert.equal(resolved, false);
  releaseWrite();
  const saved = await approval;
  assert.equal(saved.status, 'direction_locked');
  assert.equal(saved.accepted_tone, originalAnalysis.tone);
  assert.equal(saved.accepted_strategy, originalAnalysis.opportunity);
  assert.deepEqual(client.state.pods[1], { id: 'pod-two', status: 'active' });
});

test('rejected or empty approval writes fail closed', async () => {
  const rejected = fakeClient({ failTable: 'pods' });
  await assert.rejects(persistPodDirectionApproval(rejected, 'pod-one', originalAnalysis), /pods write rejected/);
  assert.equal(rejected.state.pods[0].accepted_tone, 'Old tone');

  const missing = fakeClient({ noPod: true });
  await assert.rejects(persistPodDirectionApproval(missing, 'pod-one', originalAnalysis), /could not be confirmed/);
});

test('saving an override clears approval before activating the new preference', async () => {
  const client = fakeClient({ beforeWrite: async ({ table, state }) => {
    if (table === 'pod_preferences') {
      assert.equal(state.pods[0].status, 'awaiting_direction');
      assert.equal(state.pods[0].accepted_tone, null);
      assert.equal(state.pods[0].accepted_strategy, null);
    }
  } });
  const result = await persistPodDirectionOverride(client, 'pod-one', '  Direct and practical  ');
  assert.equal(result.pod.status, 'awaiting_direction');
  assert.equal(result.preference.active, true);
  assert.equal(result.preference.pod_id, 'pod-one');
  assert.deepEqual(result.preference.preference_value, { value: 'Direct and practical' });
  assert.equal(client.state.pods[1].status, 'active');
});

test('override failures cannot leave content approved with an unconfirmed direction', async () => {
  const resetRejected = fakeClient({ failTable: 'pods' });
  await assert.rejects(persistPodDirectionOverride(resetRejected, 'pod-one', 'Direct'), /pods write rejected/);
  assert.deepEqual(resetRejected.state.preferences, []);

  const preferenceRejected = fakeClient({ failTable: 'pod_preferences' });
  await assert.rejects(persistPodDirectionOverride(preferenceRejected, 'pod-one', 'Direct'), /pod_preferences write rejected/);
  assert.equal(preferenceRejected.state.pods[0].status, 'awaiting_direction');
  assert.equal(preferenceRejected.state.pods[0].accepted_tone, null);
  assert.deepEqual(preferenceRejected.state.preferences, []);
});

test('empty directions and missing pod identity cannot mutate storage', async () => {
  const client = fakeClient();
  await assert.rejects(persistPodDirectionOverride(client, 'pod-one', '   '));
  await assert.rejects(persistPodDirectionOverride(client, '', 'Direct'));
  await assert.rejects(persistPodDirectionApproval(client, 'pod-one', null));
  assert.deepEqual(client.state.writes, []);
});

test('reload restores the newest active override and reapproval persists it', async () => {
  const preference = (value, created_at, extra = {}) => ({ active: true, preference_type: 'brand_direction', preference_value: { value }, created_at, ...extra });
  const restored = restorePodDirection(originalAnalysis, [
    preference('Newest direction', '2026-09-24T12:00:00Z'),
    preference('Old direction', '2026-09-23T12:00:00Z'),
    preference('Disabled direction', '2026-09-25T12:00:00Z', { active: false }),
    preference('Different preference', '2026-09-26T12:00:00Z', { preference_type: 'platform' }),
  ]);
  assert.equal(restored.tone, 'Newest direction');
  assert.equal(originalAnalysis.tone, 'Calm and luxurious');

  const client = fakeClient();
  await persistPodDirectionOverride(client, 'pod-one', 'Friendly and factual');
  const reloaded = restorePodDirection(originalAnalysis, client.state.preferences);
  assert.equal(isPodDirectionApprovalCurrent(client.state.pods[0], client.state.preferences), false);
  const approved = await persistPodDirectionApproval(client, 'pod-one', reloaded);
  assert.equal(approved.status, 'direction_locked');
  assert.equal(approved.accepted_tone, 'Friendly and factual');
  assert.equal(isPodDirectionApprovalCurrent(approved, client.state.preferences), true);
});
