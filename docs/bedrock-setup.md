# Amazon Bedrock alongside Dovroyn's existing AI

## What this integration changes

The authenticated analysis, content and competitor routes can use OpenAI or Amazon Bedrock. Private pod chat keeps its newly added OpenAI web research and source citations; it is not routed to Bedrock because the Converse adapter does not provide that search tool. Supabase remains the source of truth for authentication, ownership, pod memory, subscriptions and allowances. Existing approvals, source evidence checks and private-network protections still apply. The public chat route remains a local demo and cannot call either provider.

The default stays `AI_PROVIDER=openai`. No AWS resources, credentials, model subscriptions or account configuration are created by deploying this code. Bedrock is **not active** until the following setup and a real authenticated smoke test succeed.

## Production setup

1. In the intended AWS account, choose a Bedrock model or inference profile available to that account and region. Analysis needs image input. Analysis, content and competitor snapshots need Converse tool use with `toolChoice.tool`. Model capabilities differ; verify the selected exact model. Never choose a profile with cross-region processing without reviewing its destinations.
2. Configure Vercel OIDC in AWS using [Vercel's AWS instructions](https://vercel.com/docs/oidc/aws). Verify the actual Vercel issuer mode and team slug. Restrict role trust to Dovroyn and the intended environment, with exact audience and subject conditions. For the inspected team/project, the production subject is `owner:anglowdigital:project:dovroyn:environment:production`; verify it in Vercel before applying it. Preview needs its own explicitly scoped trust entry or role.
3. Give that role `bedrock:InvokeModel` only for the selected model resources. Inference profiles can also require the profile ARN and underlying regional model ARNs. Use exact resources for the approved destinations. Do not grant account administration, storage access or wildcard Bedrock access.
4. In Dovroyn's Vercel environment settings, add server-only `AWS_REGION`, `AWS_ROLE_ARN` and `BEDROCK_MODEL_ID`. The deployed function uses `@vercel/oidc-aws-credentials-provider` to obtain temporary AWS credentials; no permanent AWS access key or Bedrock API key is required. Never use a `VITE_` prefix for AI settings or credentials.
5. Set an appropriate `BEDROCK_MAX_OUTPUT_TOKENS` for the selected model (default 8192, allowed 1–32768). This limits each response, not total billing. Review AWS usage budgets and model pricing separately. Configure any workload model overrides below.
6. Test a preview deployment with an explicitly authorised test pod and working Supabase configuration. Enable one workload first, for example `AI_ANALYSIS_PROVIDER=bedrock`. Use public, non-sensitive test website/photos. Verify actual output, provenance, saved analysis and reload persistence. Then test approved content generation with an eligible subscription and verify existing OpenAI pod chat still returns its sources. Mock tests do not establish AWS access or live generation.
7. Apply only the verified settings to Production and redeploy. Environment changes do not update an existing deployment. Repeat the smoke test before treating Bedrock as active.

## Provider controls

| Server variable | Purpose |
| --- | --- |
| `AI_PROVIDER` | Default provider for analysis, content and competitor snapshots: `openai` (default) or `bedrock` |
| `AI_ANALYSIS_PROVIDER` | Override website/photo analysis |
| `AI_CONTENT_PROVIDER` | Override approved content generation |
| `AI_COMPETITOR_PROVIDER` | Override public competitor-page snapshots |
| `AI_FALLBACK_PROVIDER` | Optional alternate provider, disabled when blank |
| `BEDROCK_MODEL_ID` | Shared enabled model ID or inference profile ID/ARN |
| `BEDROCK_ANALYSIS_MODEL`, `BEDROCK_CONTENT_MODEL`, `BEDROCK_COMPETITOR_MODEL` | Optional workload model overrides |

Fallback occurs at most once and only for recognised availability/quota/transport failures. It must be explicitly enabled, and may send the same pod context to both configured providers. It never retries a refusal, unsafe image, malformed output or AWS access/configuration error with a different model. Failed content requests retain the existing allowance-release behavior. To roll back provider activation, set the affected selectors to `openai`, clear `AI_FALLBACK_PROVIDER`, and redeploy.

Bedrock receives the same bounded pod context and source labels as the original AI path. Remote images are fetched through the existing pinned public-address transport, with no redirects, a two-megabyte byte limit and timeout. Raster pixels are decoded with a pixel cap and converted to bounded JPEG. A supplied image that cannot be loaded fails the request instead of silently treating it as evidence. Structured responses must pass local JSON-schema validation before route-level provenance checks or persistence. Tool envelopes are used only to return data; no model-requested action is executed.

## Launch dependencies still separate from Bedrock

- The inspected production configuration has an OpenAI key but no AWS/Bedrock variables. No successful live AI generation is established by key presence alone.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` were absent from the inspected production configuration. Paid checkout and subscription activation need both, then a controlled payment/webhook/access test.
- The Login and Sign up links reach their forms. End-to-end signup, email verification, login, password-reset email and logout still require a test account.
- Social provider activation and posting remain separate; this change does not enable publishing or ad spend.

## Verification — 18 November 2026 (Perth)

- Integrated with `main` at `3e6a1cf6ff920e09c3d888491892eac456880063`, preserving the separately merged web-research feature.
- 554 local tests passed; production Vite build passed; whitespace checks passed. The existing bundle-size warning remains.
- Mocked Converse tests cover output validation, private/invalid images, refusal/truncation rejection, explicit fallback, authentication before provider calls and content-allowance release on failure. These do not prove a real AWS request succeeded.
- Live public `/`, `/login` and `/signup` returned HTTP 200; unauthenticated analysis/content/pod-chat/checkout returned HTTP 401. Browser navigation between login/signup and empty-email password-reset validation worked.
- The live Stripe webhook returned HTTP 500 with `stripe_not_configured`. No payment was attempted. Full signup/email delivery, signed-in generation/persistence and AWS activation remain unverified.

## References

- [AWS Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [AWS tool choice support](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use-client-side.html)
- [Vercel OIDC reference](https://vercel.com/docs/oidc/reference)
- [Existing launch verification and Stripe setup](launch-verification-20261114.md)
