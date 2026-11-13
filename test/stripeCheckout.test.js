import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutHandler } from '../api/stripe/checkout.js';
import { billingPlan, CHECKOUT_SOURCE, resolveCheckoutPrice, subscriptionPeriod } from '../api/_lib/stripeBilling.js';
import { redirectToCheckout } from '../src/lib/stripe.js';

const user = { id: '12345678-1234-4234-8234-123456789abc', email: 'account@example.test' };
const linkUrl = 'https://buy.stripe.com/test_Dovroyn';
const env = { STRIPE_SECRET_KEY: 'sk_test_checkout', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_SERVICE_ROLE_KEY: 'service-test', VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_STRIPE_STARTER_MONTHLY: linkUrl };
const price = { id: 'price_starter', active: true, livemode: false, type: 'recurring', billing_scheme: 'per_unit', currency: 'aud', unit_amount: 8900, product: { id: 'prod_starter', active: true }, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } };
const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_new';
function output() {
  const result = { headers: {} };
  const res = { setHeader(k,v) { result.headers[k]=v; }, status(v) { result.status=v; return res; }, json(v) { result.body=v; return v; } };
  return { result,res };
}
function req(body={tier:'starter',billing:'monthly'}) { return { method:'POST', headers:{authorization:'Bearer user-token',host:'attacker.test'}, body }; }
function harness(options={}) {
  const calls={created:[],expired:[],customers:[]};
  const link={id:'plink_starter',url:linkUrl,active:true,livemode:false,automatic_tax:{enabled:true},billing_address_collection:'required',tax_id_collection:{enabled:true},...options.link};
  const stripe={
    paymentLinks:{async list(){return {data:[link],has_more:false};},async listLineItems(){return options.lines || {data:[{quantity:1,price:{id:price.id}}],has_more:false};}},
    prices:{async retrieve(){return {...price,...options.price};}},
    customers:{async search(){return options.customers || {data:[],has_more:false};},async retrieve(id){return {id,metadata:{dovroyn_user_id:user.id}};},async create(p,o){calls.customers.push({p,o});return {id:'cus_account'};}},
    subscriptions:{async retrieve(){return options.existingSubscription || {status:'active'};},async list(){return {data:options.subscriptions || [],has_more:false};}},
    checkout:{sessions:{async list(){return {data:options.pending || [],has_more:false};},async expire(id){if(options.expireError)throw Error('private Stripe details');calls.expired.push(id);},async create(p,o){calls.created.push({p,o});if(options.createError)throw Error('sk_private');return {url:options.url || checkoutUrl,status:options.sessionStatus || 'open'};}}},
  };
  const handler=createCheckoutHandler({env:{...env,...options.env},verifyUser:async()=>options.user===null?null:user,loadIdentity:async()=>options.identity || null,rateLimit:()=>({allowed:options.allowed!==false}),createStripe:()=>stripe,clock:()=>1000000});
  return {stripe,handler,calls,link};
}
async function run(options={}, request=req()) { const h=harness(options);const o=output();await h.handler(request,o.res);return {...h,...o}; }

test('authenticated checkout binds both Stripe metadata objects to verified user and exact validated AUD price',async()=>{
  const {result,calls}=await run();assert.equal(result.status,200);assert.equal(result.body.url,checkoutUrl);
  const {p}=calls.created[0];assert.deepEqual(p.line_items,[{price:'price_starter',quantity:1}]);assert.equal(p.customer,'cus_account');
  assert.equal(p.client_reference_id,user.id);assert.equal(p.metadata.user_id,user.id);assert.equal(p.metadata.source,CHECKOUT_SOURCE);assert.deepEqual(p.subscription_data.metadata,p.metadata);
  assert.equal(p.success_url,'https://dovroyn.com/purchase-success?session_id={CHECKOUT_SESSION_ID}');assert.doesNotMatch(p.cancel_url,/attacker/);
  assert.deepEqual(p.automatic_tax,{enabled:true});assert.equal(p.billing_address_collection,'required');assert.deepEqual(p.tax_id_collection,{enabled:true});assert.deepEqual(p.customer_update,{address:'auto'});
  assert.equal(calls.customers[0].o.idempotencyKey,`dovroyn-customer-${user.id}`);
});

test('checkout requires authenticated user, server activation credentials and only tier/billing input',async()=>{
  for(const field of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SUPABASE_SERVICE_ROLE_KEY','VITE_SUPABASE_URL']){
    const {result,calls}=await run({env:{[field]:''}});assert.equal(result.status,503,field);assert.equal(calls.created.length,0);assert.equal(calls.customers.length,0);
  }
  assert.equal((await run({user:null})).result.status,401);
  assert.equal((await run({}, {...req(),headers:{}})).result.status,401);
  assert.equal((await run({allowed:false})).result.status,429);
  for(const body of [{tier:'__proto__',billing:'monthly'},{tier:'constructor',billing:'monthly'},{tier:'free',billing:'monthly'},{tier:'starter',billing:'week'},{tier:'starter',billing:'monthly',user_id:'victim'},{tier:'starter',billing:'monthly',price:'price_evil'}]){
    const {result,calls}=await run({},req(body));assert.equal(result.status,400);assert.equal(calls.created.length,0);
  }
});

test('checkout rejects wrong amount, currency, recurrence, inactive price/product, quantities and extra lines',async()=>{
  for(const change of [{unit_amount:1},{currency:'usd'},{active:false},{product:{active:false}},{type:'one_time'},{recurring:{interval:'year',interval_count:1,usage_type:'licensed'}},{recurring:{interval:'month',interval_count:2,usage_type:'licensed'}},{transform_quantity:{divide_by:2}},{livemode:true}]){
    const {result,calls}=await run({price:change});assert.equal(result.status,503,JSON.stringify(change));assert.equal(calls.created.length,0);assert.equal(calls.customers.length,0);
  }
  for(const lines of [{data:[{quantity:2,price}],has_more:false},{data:[{quantity:1,price},{quantity:1,price}],has_more:false},{data:[{quantity:1,price}],has_more:true}]){
    const {result,calls}=await run({lines});assert.equal(result.status,503);assert.equal(calls.created.length,0);
  }
});

test('all eight canonical plan prices are checked in cents and annual intervals',()=>{
  const expected={starter:[8900,85500],growth:[24900,239000],pro:[59900,575000],scale:[129900,1247000]};
  for(const [tier,amounts]of Object.entries(expected)) for(const [i,billing]of ['monthly','yearly'].entries()){
    const p=billingPlan(tier,billing);assert.equal(p.amount,amounts[i]);assert.equal(p.currency,'aud');assert.equal(p.interval,i?'year':'month');
  }
  assert.equal(billingPlan('__proto__','monthly'),null);
});

test('restricted test keys resolve test catalog and unknown key modes fail closed',async()=>{
  const {stripe}=harness();await resolveCheckoutPrice(stripe,{...env,STRIPE_SECRET_KEY:'rk_test_example'},'starter','monthly');
  await assert.rejects(resolveCheckoutPrice(stripe,{...env,STRIPE_SECRET_KEY:'invalid'},'starter','monthly'));
});

test('existing subscription blocks second checkout both before and after webhook provisioning',async()=>{
  for(const options of [{identity:{stripe_customer_id:'cus_old',stripe_subscription_id:'sub_existing'}},{subscriptions:[{id:'sub_paid',status:'active'}]},{subscriptions:[{id:'sub_pastdue',status:'past_due'}]}]){
    const {result,calls}=await run(options);assert.equal(result.status,409);assert.equal(calls.created.length,0);
  }
  const {result}=await run({identity:{stripe_customer_id:'cus_old',stripe_subscription_id:'sub_existing'},existingSubscription:{status:'canceled'}});assert.equal(result.status,200);
});

test('pending checkout is reused and a changed plan expires the previous session before creating another',async()=>{
  const metadata={source:CHECKOUT_SOURCE,user_id:user.id,tier:'starter',billing:'monthly',price_id:price.id};
  const existing={id:'cs_test_open',status:'open',url:'https://checkout.stripe.com/c/pay/cs_test_open',metadata};
  const same=await run({pending:[existing]});assert.equal(same.result.status,200);assert.equal(same.result.body.url,existing.url);assert.equal(same.calls.created.length,0);
  const changed=await run({pending:[{...existing,metadata:{...metadata,tier:'growth'}}]});assert.equal(changed.result.status,200);assert.deepEqual(changed.calls.expired,['cs_test_open']);assert.equal(changed.calls.created.length,1);
  const raced=await run({pending:[{...existing,metadata:{...metadata,tier:'growth'}}],expireError:true});assert.equal(raced.result.status,503);assert.equal(raced.calls.created.length,0);
});

test('provider and unsafe redirect failures do not expose internals or redirect customer',async()=>{
  for(const options of [{createError:true},{url:'https://evil.example/pay'},{sessionStatus:'expired'}]){const{result}=await run(options);assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result.body),/sk_private|evil/);}
});

test('subscription billing periods support both Acacia and single-item Basil events',()=>{
  assert.deepEqual(subscriptionPeriod({current_period_start:100,current_period_end:200}),{periodStart:100,periodEnd:200});
  assert.deepEqual(subscriptionPeriod({items:{data:[{quantity:1,current_period_start:200,current_period_end:300}]}}),{periodStart:200,periodEnd:300});
  for(const value of [{},{items:{data:[{quantity:2,current_period_start:200,current_period_end:300}]}},{items:{data:[{quantity:1,current_period_start:200,current_period_end:300},{quantity:1,current_period_start:300,current_period_end:400}]}}])assert.throws(()=>subscriptionPeriod(value));
});

test('browser checkout sends only selection and bearer token, redirects only to hosted Stripe and uses safe errors',async()=>{
  const requests=[];const redirects=[];const target={location:{assign(url){redirects.push(url);}}};
  const fetchImpl=async(url,init)=>{requests.push({url,init});return {ok:true,status:200,json:async()=>({url:checkoutUrl})};};
  await redirectToCheckout('growth','yearly',{accessToken:'token',fetchImpl,target});
  assert.deepEqual(JSON.parse(requests[0].init.body),{tier:'growth',billing:'yearly'});assert.equal(requests[0].init.headers.Authorization,'Bearer token');assert.deepEqual(redirects,[checkoutUrl]);
  await assert.rejects(redirectToCheckout('starter','monthly',{fetchImpl,target}),/Sign in/);
  for(const [status,url]of [[503,checkoutUrl],[200,'https://evil.example']])await assert.rejects(redirectToCheckout('starter','monthly',{accessToken:'token',target,fetchImpl:async()=>({ok:status===200,status,json:async()=>({url,error:'sk_private'})})}),e=>!e.message.includes('sk_private'));
  assert.equal(redirects.length,1);
});

test('checkout idempotency stays stable across time and plan choices, advancing after the last closed session',async()=>{
  const a=await run();
  const h=harness();const seen=[];
  h.stripe.checkout.sessions.create=async(p,o)=>{seen.push(o.idempotencyKey);return {url:checkoutUrl,status:'open'};};
  const options={env,verifyUser:async()=>user,loadIdentity:async()=>null,rateLimit:()=>({allowed:true}),createStripe:()=>h.stripe,resolvePrice:async()=>({price,link:h.link})};
  for(const [tier,clock]of [['starter',()=>599999],['growth',()=>600000]]){
    const out=output();await createCheckoutHandler({...options,clock})(req({tier,billing:'monthly'}),out.res);assert.equal(out.result.status,200);
  }
  assert.equal(seen[0],seen[1]);assert.equal(seen[0],a.calls.created[0].o.idempotencyKey);
  const closed=await run({pending:[{id:'cs_test_previous',status:'expired'}]});
  assert.notEqual(closed.calls.created[0].o.idempotencyKey,seen[0]);
});
