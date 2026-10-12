import test from 'node:test';
import assert from 'node:assert/strict';
import {runMetaOrganicScheduler} from '../api/_lib/metaOrganicScheduler.js';

const schedulerConfig={enabled:true,secretConfigured:true,secret:'synthetic-secret',batchLimit:1,budgetMs:5000};
const req={headers:{authorization:'Bearer synthetic-secret'}};

test('scheduler threads its remaining deadline into readonly reconciliation',async()=>{
 const now=new Date();let observed;
 const result=await runMetaOrganicScheduler({req,schedulerConfig,publisherConfig:{enabled:true,leaseMs:30000},now,
  store:{readiness:async()=>({ready:true}),claimNext:async()=>null,
   claimUnknownForReconciliation:async()=>({id:'job-1',provider:'facebook',accountConnectionId:'conn-1',providerAccountId:'101',dedupeKey:'a'.repeat(64),receipts:{'conn-1':{providerAccountId:'101',providerPostId:'101_999'}}}),
   loadReconciliationCredentialLease:async()=>({provider:'facebook',providerAccountId:'101',tokenKind:'page',accessToken:'synthetic-token'}),keepUnknown:async()=>{}},
  provider:{lookupPublishedMetaOrganicReceipt:async(hints,context)=>{observed=context.deadlineAt;return null;}}
 });
 assert.equal(observed,new Date(now.getTime()+5000).toISOString());
 assert.equal(result.reconcile[0].status,'unknown');
});

test('scheduler stops claiming at the shorter lease deadline, before larger batch budget',async(t)=>{
 const original=Date.now;const started=original();let clock=started;Date.now=()=>clock;t.after(()=>{Date.now=original});
 const result=await runMetaOrganicScheduler({req,schedulerConfig:{...schedulerConfig,budgetMs:55000},publisherConfig:{enabled:true,leaseMs:30000},now:new Date(started),
 store:{readiness:async()=>({ready:true}),claimNext:async()=>{clock=started+26000;return null;},claimUnknownForReconciliation:async()=>assert.fail('must not claim beyond lease-safe deadline')},provider:{}});
 assert.deepEqual(result.reconcile,[]);
});
