# DOVROYN LAUNCH KIT — first paying customers

## Read this first: the one honest gap
There is no Stripe webhook yet. After a customer pays, the app does NOT auto-unlock
their plan — you activate each paying customer manually (60 seconds, SQL in Step 4).
That is completely normal for a first launch. We automate it once you have 10+ customers.

## STEP 1 — Stripe (~30 min; start NOW because account verification can take time)
1. dashboard.stripe.com → create/activate account (AU: have your ABN + ID + bank details ready)
2. Products → Add product, one for each plan, monthly pricing:
   - "Dovroyn Starter Pod" — $89/mo — 1 pod
   - "Dovroyn Growth Pods" — $249/mo — up to 3 pods
   - "Dovroyn Pro Marketing Pods" — $399/mo — up to 5 pods
   - "Dovroyn Scale / Agency" — $1,299/mo
3. On each product: "Create payment link" → copy each link
4. Vercel app → your project → Settings → Environment Variables → add:
   - VITE_STRIPE_STARTER_MONTHLY = <link>
   - VITE_STRIPE_GROWTH_MONTHLY = <link>
   - VITE_STRIPE_PRO_MONTHLY = <link>
   - VITE_STRIPE_SCALE_MONTHLY = <link>
5. Vercel → Deployments → ⋯ → Redeploy
(Yearly: VITE_STRIPE_*_YEARLY — optional, add later)

## STEP 2 — OpenAI key (5 min)
Vercel → Environment Variables → add OPENAI_API_KEY (no VITE_ prefix — server-side only).
Without this, pod analysis fails for real customers. Set a monthly spend cap in the
OpenAI dashboard so costs can't run away.

## STEP 3 — Your domain (15 min) — STOP sending people the vercel.app preview link
1. Vercel app → project → Settings → Domains → add `dovroyn.com` and `www.dovroyn.com`
2. At your domain registrar's DNS settings:
   - A record, host `@` → `76.76.21.21`
   - CNAME, host `www` → `cname.vercel-dns.com`
3. SSL is automatic (a few minutes). Test: open https://dovroyn.com

## STEP 4 — Activate a paying customer (60 seconds each, until the webhook exists)
After their payment shows in Stripe:
1. Customer opens Dovroyn → Account → copy their User ID
2. Supabase → SQL Editor → run (example: Growth plan):

   insert into public.subscriptions (user_id, tier, status, max_pods, monthly_content_days, current_period_end)
   values ('PASTE_USER_ID', 'growth', 'active', 3, 12, now() + interval '1 month');

   If it errors about a missing column, run this once and send me the output:
   select column_name from information_schema.columns where table_name = 'subscriptions' order by ordinal_position;

3. Tell the customer to refresh — their plan is live.

## STEP 5 — Founding-customer offer (first 10 sales)
- In Stripe create a Coupon (50% off 3 months) and attach it to a second payment link
  per plan = your "Founding Member" link. Use it in every pitch.
- Where to find customers TODAY:
  1. Your own 5 brands = the proof. Screenshot the pods, post them as case studies.
  2. Aus small-business FB groups ("small business australia", tradie/cleaning/salon groups).
  3. Businesses you already know personally — offer to set them up free, they pay only if they keep it.
  4. Your followers/subscribers — you built an audience around building apps; they're buyers.

## STEP 6 — The honest product promise (use exactly this framing)
"Dovroyn builds your complete marketing direction, 30-day content calendar, and
ready-to-post content for every platform — in your brand's voice. You approve everything,
then post with one tap. Auto-posting switches on as platform approvals complete."
Do NOT promise automatic posting yet — Meta/TikTok approvals take days/weeks.
For founding members, offer concierge: they approve, YOU post it for them. That is a
premium service, not a limitation.

## DM script
"Hey [name] — I built an AI that does your whole marketing plan: brand strategy,
30-day content calendar, and posts written for FB/IG/TikTok in your voice.
I'll set it up for you free and you see everything before paying a cent.
Worth 15 minutes? — Jae, Dovroyn"

## Later this week (already queued with your developer)
- Stripe webhook → customers auto-activate on payment
- Meta developer app → real Facebook/Instagram/Threads posting
- [x] Stripe payment links added to Vercel env vars (rebuild triggered to bake them in)
