# Building Greenlit

Notes on how I built Greenlit — a Chrome extension that scores LinkedIn job postings against your resume using Claude — and the decisions I made along the way. This is a portfolio write-up, so it's first-person and honest about tradeoffs. I'd rather tell you what went wrong than pretend it all went smoothly.

## The problem

I'm a career switcher, moving out of BIM engineering and into cloud / devops / software. LinkedIn's job feed is a firehose: postings look promising for about two seconds, then reveal a "5+ years of Kubernetes in production" requirement I don't have. I was wasting whole evenings clicking through jobs that were never going to happen, and I noticed I was getting less honest with myself the longer I scrolled.

I wanted a tool that would read a job posting, compare it against my actual resume, and tell me — brutally, not nicely — whether it's worth applying. "Apply with signal, not hope" became the design brief.

The first version of Greenlit was a throwaway Chrome extension with a textarea where the user pasted their own Anthropic API key, plus a 60-line regex-based PDF parser running in the browser. It worked for me, which was the whole point. But "paste your API key into a textarea" is not something I'd ever ship to another human, and the PDF parser broke on almost every resume I tried that wasn't mine. So I rebuilt it properly.

## Architecture

The current stack:

- **Chrome Extension (Manifest V3), vanilla JS.** Content script on LinkedIn job pages, service worker for backend calls and auth, popup for profile editing, sign-in, and billing management. The content script never touches Anthropic or the billing provider — it only talks to the service worker, which only talks to our backend.
- **Five AWS Lambdas, TypeScript on arm64**, bundled with esbuild into individual zips:
  - `analyze` — fetches the user's profile, checks quota, calls Claude, caches the verdict.
  - `profile` — GET/PUT for the user profile (resume text + preferences), also surfaces usage + billing state to the popup.
  - `upload` — accepts a base64-encoded PDF, runs server-side text extraction via `pdf-parse`, writes the original PDF to S3, merges the extracted text onto the user row.
  - `lemon-billing` — handles `POST /billing/checkout-session` and `POST /billing/portal-session`. Creates Lemon Squeezy checkout and customer-portal URLs, and is the only place the LS API key is used.
  - `lemon-webhook` — handles `POST /billing/webhook`. Signature-verified, unauthenticated from a user perspective, drives tier and quota state in DynamoDB based on subscription events.
- **API Gateway v2 HTTP API** with a **Cognito JWT authorizer** on every authenticated route. The webhook route is the only `authorization_type = "NONE"` endpoint on the API — authentication happens inside the webhook Lambda via HMAC-SHA256 signature verification before any DynamoDB write.
- **AWS Cognito User Pool** for email + password auth. The extension talks to `cognito-idp.eu-central-1.amazonaws.com` directly via the JSON RPC API (`SignUp`, `ConfirmSignUp`, `InitiateAuth`, `ResendConfirmationCode`). No SDK, so the bundled extension stays tiny.
- **DynamoDB** with two tables: `users` (profile, resume text, billing state, quota counters, keyed on the Cognito `sub`) and `cache` (analysis results keyed on `(userId, jobId)` with a 30-day TTL on the item). The extension also caches successful analyses client-side in `chrome.storage.local` with a 7-day TTL keyed on jobId — cached re-views render instantly and cost zero API calls.
- **S3** for the raw resume PDFs. Encrypted at rest (AES256), bucket policy denies any request without TLS, public access fully blocked, versioning off because the PDFs are disposable.
- **AWS Secrets Manager** holds three secrets: the Anthropic API key, the Lemon Squeezy API key, and the Lemon Squeezy webhook signing secret. Each Lambda gets access to only the secrets it actually needs. Values are cached per warm container so Secrets Manager round-trips only happen on cold starts.
- **Lemon Squeezy** for payments. Hosted Checkout + Customer Portal + webhooks.
- **Terraform** for everything. Remote state in S3 with a DynamoDB lock table — bootstrapped from a separate one-shot Terraform stack so the state bucket itself is managed as code rather than created by hand.

The thing I care about most in this architecture is a single sentence: **the extension is dumb and the backend holds the keys.** Every pattern where a browser extension carries a third-party API key is one credential leak away from a billing disaster. Users trust Greenlit with a login, not a key, and that's the right contract.

## Security decisions

I tried to treat this like a real product even though it's a side project. Notes on what I did and why:

**Third-party API keys in Secrets Manager.** The Anthropic key is a `TF_VAR_anthropic_api_key` passed at apply time, landing in a `SecretString`. Lambdas fetch it at cold start via `secretsmanager:GetSecretValue`, cache it in a module-level variable for the container lifetime, and never persist it to disk. The key never appears in the Lambda package, the environment variables, or the logs. The two Lemon Squeezy secrets — API key and webhook signing secret — use the same pattern, with separate ARNs so each Lambda can be granted exactly the keys it needs. LS secret values are populated manually via `aws secretsmanager put-secret-value` after the first `terraform apply` (Terraform stores only a placeholder and ignores future changes to the value), so the real secrets never live in any tfvars file or git history.

**Least-privilege IAM, one role per Lambda.** Each function has its own IAM role with an inline policy listing exactly the resources it needs by ARN. `analyze` gets `Get/Put/UpdateItem` on the users and cache tables plus `GetSecretValue` on the Anthropic secret. `profile` gets `Get/Put/UpdateItem` on users only. `upload` gets `s3:PutObject` scoped to `resumes/*` on the resume bucket plus `UpdateItem` on users. `lemon-billing` gets `Get/Put/UpdateItem` on users plus the LS API key. `lemon-webhook` gets `UpdateItem` on users plus both LS secrets. No Lambda in this stack has `s3:*`, `dynamodb:*`, or `logs:CreateLogGroup`. Log groups are pre-created by Terraform so the Lambdas only need `logs:PutLogEvents` on their own group.

**Encrypted, private resume bucket.** AES256 at rest, TLS-only via a bucket policy that denies `s3:*` when `aws:SecureTransport` is false, public access block fully enforced. The bucket name has a random suffix so it can't be guessed.

**Cognito JWT on every authenticated route.** API Gateway validates the token before invocation. The Lambdas read the `sub` claim off `event.requestContext.authorizer.jwt.claims` and never trust any identity field from the request body. The only unauthenticated endpoint is `POST /billing/webhook`, which is protected by HMAC-SHA256 signature verification inside the Lambda — the raw request body is verified against the LS signing secret before any parsing or DynamoDB write. A 400 "Invalid signature" response ships back in milliseconds, before any code path that touches state.

**Thoughtful CORS.** API Gateway allows `["*"]` because Chrome extensions bypass CORS entirely via `host_permissions` in the manifest — pinning the origin there adds no protection and just creates a deploy-time chicken-and-egg with the extension ID. But the S3 resume bucket CORS is pinned to the real extension ID, because the browser talks to S3 directly for the presigned PUT path and that request does honor CORS.

**Terraform state protection.** The state bucket has versioning, encryption, and `lifecycle.prevent_destroy = true`. The DynamoDB lock table has `deletion_protection_enabled = true`. `terraform destroy` on the main stack won't orphan the state; `terraform destroy` on the bootstrap stack will refuse to run at all.

## Technical challenges worth talking about

### 1. LinkedIn is a SPA and its DOM isn't stable

LinkedIn swaps the job detail panel in place when you click a different card — no URL change, no page load, no `popstate` event. My first pass at "inject a badge when a job detail is on screen" just checked `document.querySelector('.jl-detail-panel')` and bailed if something was already rendered. Result: the first job's score pinned to the page, stale through the next ten jobs the user clicked on.

The fix was to tag each rendered panel with a `data-jl-job-id` attribute and compare it against the *current* job ID on every MutationObserver tick. If they mismatch, the stale panel gets removed and a fresh one goes in. Any in-flight analysis on the old panel becomes a no-op when it resolves, because `panel.replaceWith()` on a detached node does nothing in modern DOM. The observer is debounced at 600 ms so LinkedIn's own DOM churn doesn't trigger a re-render on every mutation.

LinkedIn also uses a mix of class names (`jobs-unified-top-card__*`, `job-details-jobs-unified-top-card__*`) depending on which A/B test the user is in, so every selector has three or four fallback variants. The description extractor is the most defensive: eight named selectors in order, then a container-scan heuristic that walks every `div` inside the top-card container and picks the first one with more than 200 characters of text. Each attempt logs `[Greenlit] description: matched "<selector>" (N chars)` to the console, so when LinkedIn inevitably ships a class rename, the browser DevTools tell me which fallback caught it (or that every selector missed). This layer is going to break on some future LinkedIn refactor, and I've accepted that — when it does, it's a CSS-selector patch, not an architecture change.

The location extraction got its own fun problem. The top card renders a series of bullet spans: location, work arrangement badge, posted time, applicant count. They're siblings with overlapping classes, and my first selector grabbed the "Hybride" badge as the location. I rewrote the extractor to walk candidates in order and skip anything matching a work-arrangement regex (`hybrid|remote|op afstand|op locatie|on-site|in-person`, EN + NL because I'm in the Netherlands) or a posted-time / applicant-count regex. Work arrangement then gets extracted separately and passed to the backend as its own field, which the prompt factors into the location breakdown — a remote role has near-zero location sensitivity, a strictly on-site role in a different city is a hard no.

### 2. PDF parsing in the browser is a trap

The MVP's PDF parser was ~60 lines of regex that matched `BT...ET` blocks and extracted `(...) Tj` literals. It worked on the exact PDF I built it against and broke on basically everything else — compressed streams, modern PDF.js output, anything with embedded fonts or non-Latin characters.

I moved extraction server-side. The popup base64-encodes the file in chunks (naive `String.fromCharCode(...bytes)` explodes the call stack past ~100 KB, so I chunk at 32 KB), POSTs it to `POST /resume/upload`, and the Lambda runs `pdf-parse` against the decoded buffer. On success, the Lambda writes the raw PDF to S3 using its own IAM role, `UpdateItem`s the user row in DynamoDB with the new resume text (using `SET` so existing preferences aren't clobbered), and returns the text in the same response. One round trip, one upload, no double-writing the bytes.

Two gotchas I hit that the `pdf-parse` docs do not mention:

1. **`pdf-parse`'s default import runs a debug block at import time that tries to read a bundled test PDF.** In a Lambda runtime, `./test/data/05-versions-space.pdf` doesn't exist, and the import synchronously throws. The workaround is to import from `pdf-parse/lib/pdf-parse.js` directly, which bypasses the package `index.js` where the debug block lives. This is a well-known trick in GitHub issues but invisible in the docs.
2. **`@types/pdf-parse` only declares the package root.** The subpath import above breaks TypeScript. I added a tiny `pdf-parse.d.ts` shim that re-exports the default from the parent module — three lines.

API Gateway v2's 10 MB body limit is a hard ceiling. Base64 inflates by ~33%, so the real raw-PDF ceiling is about 7.5 MB. I enforce 7 MB on both the client (a pre-flight size check with a friendly error) and the Lambda (before even decoding the base64).

The upload Lambda was also bumped to 512 MB / 30 s because `pdf-parse` is memory-bound on larger documents — the default 256 MB / 10 s was fine for a one-page resume but OOM'd on dense five-pagers.

### 3. Cognito auth flow edge cases

Cognito's email confirmation flow has a nasty UX hole by default: user signs up, closes the popup before entering the code, comes back later, tries to sign in, and gets `UserNotConfirmedException` with no path to actually enter the code they already received. My first version of the popup had no way out of this state — you had to delete the user in the Cognito console and start over.

I wrote a `showConfirmPane()` helper and wired three entry points to it:

- **Sign-in handler:** catches `err.code === 'UserNotConfirmedException'` and routes straight to the confirm pane, carrying email + password so auto-sign-in runs after verification.
- **Sign-up handler:** flows into confirm as before, just via the shared helper.
- **"Already have a code?" link** on the signup pane: jumps to confirm without re-signing up, using whatever email the user has typed.

I also added a `ResendConfirmationCode` button on the confirm pane (and a new method on the auth module). To make error handling sane across every flow, I modified the generic Cognito RPC helper to attach `err.code = data.__type` on every thrown error, so callers can branch on the exact Cognito error type (`UserNotConfirmedException`, `CodeMismatchException`, `LimitExceededException`) instead of string-matching against the human-readable `message` field.

### 4. Prompt caching and a two-layer result cache

Claude supports prompt caching with a 5-minute TTL on blocks marked `cache_control: { type: 'ephemeral' }`. The resume text plus the career-switcher instructions are the biggest chunk of every analysis prompt, and they're identical across every call for a given user. I structured the system block as `[SYSTEM_INSTRUCTIONS, resumeBlock]` and marked only the resume block as ephemeral. Because cache markers cover everything up to and including the marked block, this caches the entire static prefix (instructions + per-user resume) in a single chunk. Every subsequent call only pays full tokens for the job posting itself, which is small.

On top of prompt caching there are two layers of result caching so we don't even call Claude twice for the same job:

1. **Server-side:** DynamoDB stores every successful analysis in a cache table keyed on `(userId, jobId)` with a 30-day TTL, so revisiting the same job costs zero API calls. A `force: true` flag on `POST /analyze` lets the user bypass the cache and re-run from scratch — wired to a "Re-analyze" button in the result panel. The fresh result overwrites the stale entry on the cache PUT, so I didn't need a separate cache-delete endpoint or any new IAM surface.

2. **Client-side:** the extension also caches results in `chrome.storage.local`, keyed on jobId, with a 7-day TTL. On navigation back to a job the extension has already analyzed, the content script renders the verdict *before* any network call — no `/analyze` round-trip, no quota charge, no cold-start delay. Cache hits are free even for paid users. The async `chrome.storage.local.get` happens inside the debounced MutationObserver tick, and I re-verify the current job ID after the await so a user clicking between cards quickly doesn't get a panel rendered for a stale job.

**The biggest cost mistake I made and then fixed.** The first version of the content script injected a badge on every visible job card in the LinkedIn feed and fired an `/analyze` call for each. On a single scroll, that was 20+ parallel Anthropic calls. I watched my CloudWatch invocation graph spike into a wall and immediately ripped feed-card analysis out entirely. The extension now only scores the open job detail panel, and only when the user clicks an explicit "Analyze with Greenlit" button. Passive browsing is free. The MVP had the right idea (automatic badges everywhere) but the wrong cost model — I'd rather make the user click.

### 5. Quota enforcement and billing-anchor-aligned resets

Once the product moved beyond "just for me", I needed real quota enforcement before a signed-in user could run up a bill on my Anthropic account. The tier model is straightforward:

- **Trial:** 10 analyses, lifetime cap. Never resets. This is the "try it out" tier.
- **Starter / Pro / Max:** 100 / 300 / 1000 analyses per month. Resets monthly, aligned to the user's Lemon Squeezy billing anchor — *not* a calendar-1st global reset.

The relevant state lives on the user row: `tier`, `lifetimeAnalyses`, `monthlyAnalyses`, `quotaResetDate`. The `analyze` handler checks the right counter against `TIER_LIMITS[tier].limit` before calling Claude, and if the check fails it returns a structured `429 quota_exceeded` response with `tier`, `used`, `limit`, and `resetDate` on the way out. The extension catches that specific shape and renders a dedicated upgrade panel with three tier buttons, instead of the generic error panel.

**Why billing-anchor resets instead of a calendar-1st reset?** A calendar reset is simpler but unfair — someone subscribing on the 30th of the month would get one day of value before their counter rolls over. Aligning to the LS billing anchor means a user who pays on the 17th has their quota reset on the 17th of every month, regardless of calendar boundaries. The trade-off is that resets now need to be event-driven rather than time-driven: when LS fires an `invoice.paid` or `subscription_payment_success` webhook, the handler reads the subscription's new `renews_at`, writes it to `quotaResetDate`, and zeros the monthly counter.

The tricky bit is making that webhook handler idempotent. LS (like Stripe) retries webhooks on failure, and `subscription_updated` can fire for reasons that have nothing to do with a period rollover — card updates, metadata changes, plan switches mid-cycle. If I blindly reset the counter on every `subscription_updated`, a user's usage would zero out every time they changed their payment method. The fix is a two-update pattern:

1. An **unconditional** update for fields that always take the latest value: `tier`, `subscriptionStatus`, `lemonCustomerId`, `lemonSubscriptionId`.
2. A **conditional** update for the counter reset, with `ConditionExpression: 'attribute_not_exists(quotaResetDate) OR quotaResetDate <> :new'`. This only fires when the stored period end differs from the new one — so replays, card updates, and out-of-order deliveries are all harmless no-ops. DynamoDB throws `ConditionalCheckFailedException` when the condition doesn't match, which I catch and treat as expected.

The trial tier has its own quirk: `lifetimeAnalyses` never resets, so a user who burns their 10 trial calls, subscribes to Pro, uses it for three months, and then cancels drops back to trial with `lifetimeAnalyses = 10` already on the clock — instantly locked out. This is intentional. Resetting lifetime on cancel would create a subscribe-cancel-subscribe-cancel loop for free quota forever.

### 6. Lemon Squeezy integration and the Stripe → Lemon Squeezy swap

The billing system was originally built on Stripe. I wrote the full thing — checkout-session Lambda, webhook Lambda with signature verification, `automatic_tax: { enabled: true }` for EU VAT, the metadata-based lazy product/price creation pattern that Stripe's API supports beautifully — applied it to AWS, and confirmed the end-to-end worked in test mode.

Then I looked at the commercial side more carefully and decided to swap the whole thing to Lemon Squeezy.

**The reason was VAT compliance, not technical.** Stripe is a payment processor; *you* are the merchant of record. That means for EU B2C digital sales you need to register for VAT OSS, file quarterly returns in your home country, and handle tax-rate lookups for every EU country you sell into. Stripe Tax automates the *calculation* (for ~0.5% of revenue), but you still own the filing. For a solo side project that might do €500/month in revenue, the compliance overhead was disproportionate to the money involved.

Lemon Squeezy is a Merchant of Record. They sell the product to the buyer, collect VAT at the buyer's local rate, and remit it on my behalf. Their fee is higher (~5% + €0.50 per transaction vs. Stripe's combined ~3.4%), but they absorb the entire EU tax compliance surface. For my situation the higher cut was obviously worth it.

The swap itself was a good exercise in reversible infrastructure changes. I'd already applied the Stripe stack to AWS, so this wasn't just "delete some files". The Terraform plan came back with **20 creates, 20 destroys, and 4 in-place changes** — every Stripe resource coming down, every Lemon Squeezy resource going up, and the three existing non-billing Lambdas re-hashing because they shared `dynamo.ts` imports. I reviewed the plan line by line before running apply, and made one deliberate design decision while I was at it: the API routes became provider-neutral (`/billing/checkout-session`, `/billing/portal-session`, `/billing/webhook`) rather than `/lemon/*`, so the extension doesn't carry the billing provider's name in its URLs and a future swap would touch zero extension code.

Lemon Squeezy's API differs from Stripe's in a couple of architectural ways worth noting:

- **No lazy product creation.** Stripe's "search by metadata, create if missing" pattern works reliably for programmatic setup — you can initialize an entire catalog from a cold-start Lambda. LS's product-creation API exists but is less battle-tested, and LS integrations in the wild almost always use dashboard-created products with variant IDs baked into config. I went with the dashboard-first pattern: user creates the three products manually in the LS dashboard, pastes four IDs (store + three variants) into tfvars, and the Lambda reads them from env vars at runtime. This costs some "works identically in test and live mode" ergonomics that Stripe had, but it's more robust.

- **`custom_data` on checkout replaces customer-metadata round-trips.** With Stripe, I had to create the customer object up front via the API, stamp `metadata.cognitoSub` on it, then pass the customer ID into the Checkout Session — a two-step dance that also required writing the Stripe customer ID back to DynamoDB before checkout could complete. Lemon Squeezy lets you pass arbitrary JSON into `checkout_data.custom`, and that object is echoed back on *every* webhook event for the resulting subscription via `meta.custom_data`. The LS webhook handler never does a customer-lookup round-trip — it reads `meta.custom_data.cognito_sub` straight from the event payload and the correlation is done. Simpler code, one less network call, one less thing that can fail.

- **Different webhook signing algorithm.** Stripe uses a timestamp-prefixed SHA256 HMAC with a specific header format. LS uses a plain HMAC-SHA256 of the raw request body, hex-encoded, in an `X-Signature` header. The verification is about 10 lines of `node:crypto`, which is why I hand-rolled it rather than pulling in the official `@lemonsqueezy/lemonsqueezy.js` client — the client bundles a few hundred KB of code for an API surface (create checkout, retrieve subscription, retrieve customer, verify webhook) I could fit in a 150-line library file with inline types. Bundle size matters on a Lambda cold start.

### 7. The IAM incident — a real production debugging story

Shortly after shipping the quota system, I pulled up the extension to test an analyze call and got a generic 500 back. The extension said "Backend error 500" and — as is traditional with browser UX — the CloudWatch logs that actually explained the error were nowhere near the user-facing message. Here's the full debugging arc, because it's the single best "I know how to operate AWS in anger" moment in this project.

**Step 1: get the real error.** Tailed `/aws/lambda/greenlit-analyze` for the last ten minutes. The log line that mattered:

```
AccessDeniedException: User: arn:aws:sts::…:assumed-role/greenlit-analyze/greenlit-analyze
is not authorized to perform: dynamodb:UpdateItem on resource:
arn:aws:dynamodb:eu-central-1:…:table/greenlit-users because no identity-based
policy allows the dynamodb:UpdateItem action
```

Clear and specific: the analyze Lambda's assumed role was trying to call `UpdateItem` on the users table, and IAM was refusing.

**Step 2: trace it to the code change.** Before the quota work, `analyze` only *read* user data — `GetItem` for the profile, `PutItem` for the cache write. The IAM policy reflected exactly that: `dynamodb:GetItem` and `dynamodb:PutItem` on both tables, nothing else. When I added the quota logic, the handler grew three new DynamoDB operations I hadn't accounted for in the policy:

- `incrementUsage()` — `UpdateItem` to bump `lifetimeAnalyses` and `monthlyAnalyses` after a successful model call.
- `getOrInitUser()`'s legacy-row backfill — `UpdateItem` to stamp default tier fields onto pre-quota user rows.
- `getOrInitUser()`'s monthly reset logic — `UpdateItem` to zero the counter on period rollover (later removed when LS webhooks took over, but present at the time of this bug).

I'd shipped the code change without updating the IAM policy. The Lambda deployed, the next real request hit the new code path, IAM rejected it, and the extension saw a 500. **This is the most classic infrastructure-as-code footgun there is:** your handler code and your IAM policy must evolve together, and it is very easy for a code change to silently outgrow the permissions that worked yesterday.

**Step 3: scope the fix.** Added `"dynamodb:UpdateItem"` to the `DynamoAccess` statement in `infra/iam.tf` on the analyze Lambda's role. Also added it to the profile Lambda's role — the profile PUT handler had recently switched from `PutCommand` to `UpdateCommand` to preserve quota fields written by webhooks, and it was one `/profile` call away from hitting the same wall. Two lines in the whole file.

**Step 4: verify the fix with a targeted plan.** I ran:

```bash
terraform plan \
  -target=aws_iam_role_policy.analyze_inline \
  -target=aws_iam_role_policy.profile_inline
```

Terraform's own warning about `-target` says it's "not for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes" — which is precisely what this was. The plan came back cleanly: two in-place updates, `+ "dynamodb:UpdateItem"` added to each existing DynamoAccess statement, nothing else in the state diff.

**Step 5: apply and verify live.** `terraform apply` with the same two targets. 2 changes, 0 destroys. IAM policy updates propagate to existing assumed-role sessions within seconds — unlike Lambda environment-variable updates, which take several seconds and can race with in-flight requests. The next `/analyze` call from the extension came back 200.

**What I took from this, in order of importance for future me:**

- **Read the error, don't guess.** The AccessDenied message names the exact principal, the exact action, and the exact resource. Every piece of information I needed was in the first log line. The instinct to start re-reading my own code before reading the error message is a time-waster that I catch myself doing every time.
- **IAM and code must move together.** Any time a handler gains a new DynamoDB, S3, or Secrets Manager operation, the first thing I now check is whether the Lambda's IAM role already covers it. I briefly considered adding a pre-deploy script that greps Lambda source for `dynamodb:*` operations and diffs against the Terraform policy — overkill for this scale, but it's a real pattern at larger orgs and I can see why.
- **`terraform plan -target` exists for exactly this.** Scoping the plan to the two resources that needed changing meant I could verify the blast radius was two IAM policies and nothing else. A full `plan` would have included unrelated pending changes in the diff and I'd have had to mentally filter them — slower, more error-prone. Targeted plans are explicitly for recovery situations, not routine use, and Terraform itself tells you so. But when it fits, it fits.
- **The whole incident was ~90 seconds from "500 error" to "200 OK".** The AWS feedback loop is short enough that you can debug production in-flight, provided you have CLI access, you know where the logs live, and you don't panic.

### 8. Prompt engineering and skill equivalency

The model's job is to score a job posting against a resume honestly, from a career-switcher's perspective. Early versions were too literal — the model would see "5+ years of Azure" on the job and "4 years of AWS" on the resume and score it 0% on skills. That's not how a real recruiter reads either of those résumés. AWS experience transfers to Azure, C# transfers to Java, BIM engineering transfers to BIM management even if the specific tools differ.

I rewrote the system instructions to include an explicit "skill equivalency" rule with concrete anchor points the model could lean on instead of guessing:

- **Cloud providers.** AWS, Azure, and GCP share most of their fundamentals — IAM, networking, serverless, IaC, CI/CD, observability — and those transfer directly. A strong AWS candidate on an Azure job should score around 60–70% on skills with a note about the provider gap, not 0%. Provider-specific tooling that doesn't transfer (Entra ID specifics, AWS Organizations specifics) should be deducted from the score, not used to zero it out.
- **Programming languages.** Score by family and paradigm similarity, with explicit reference points: C# ↔ Java ~70%, Python ↔ JavaScript ~50%, C++ ↔ Java ~30%, TypeScript ↔ JavaScript ~90%. Giving the model named anchors beats asking it to reason from first principles, every time.
- **Domain knowledge.** A BIM engineer applying to a BIM Manager role already knows clash detection, federated models, LOD specs, IFC, coordination workflows, stakeholder dynamics — all transferable even if the specific tool (Revit vs. Tekla vs. ArchiCAD) differs. Tool-level transfer inside a domain is a real thing and the model needed permission to reason that way.
- **A floor rule.** 0% on skills is only allowed when there is genuinely zero overlap on *any* dimension above. Anything with *some* transferable element gets partial credit plus a note explaining what transfers and what gaps remain. No more "0% incomplete posting" as a cop-out.

That floor rule dovetails with a separate rule for **missing or limited job descriptions**. Before this rule, a posting where the extractor only grabbed the title would produce "score: 0, verdict: incomplete posting" — useless to the user, and not even an accurate reflection of what the model could have inferred from a senior-level job title alone. The new rule says: do a best-effort assessment from whatever is available (title, company, location, work arrangement), include a phrase like "Limited description — assessment based on title only" in `shortReasons` so the user understands why confidence is lower, and never refuse to score. On the backend side, the user-message block flags descriptions under 200 characters as `(LIMITED — only N characters available)` so the model takes the best-effort branch deterministically rather than guessing whether the input is a real short posting or a parser failure.

All of these rules live in a single `SYSTEM_INSTRUCTIONS` string that goes into the cached system block, so every request pays the tokens for the instructions exactly once per 5-minute window per user. Prompt engineering stops being "writing paragraphs at the model" and starts looking a lot more like writing code: there's a spec, there are failure modes, there's a test loop, and there are anchor points you can reach for when the model is freelancing.

## What I'd do next

- **Chrome Web Store release.** The extension is ready except for the store chores — screenshots at the right sizes, description, privacy disclosure, proper icon assets. This is a week of polish, not engineering.
- **CloudWatch billing alarms.** I've got a mental model for the per-request cost, but I'd rather have a budget alarm that pages me if my Anthropic or Lemon Squeezy spend crosses a ceiling. Cheap to set up, one-time work, and it's one of the few things I'd want in place *before* a public launch rather than after.
- **Per-user cost visibility.** Today I have aggregate Lambda invocations in CloudWatch and aggregate Anthropic spend in the Anthropic dashboard, but nothing that tells me "user X is responsible for Y% of this month's cost". A `usdCentsEstimate` field on each analyze call, summed on the user row, would give me that cheaply — and the same field doubles as an internal sanity check on the quota pricing.
- **DOM selector resilience.** A richer set of fallback selectors, plus anonymous telemetry (opt-out, explicitly disclosed) so I know when a LinkedIn class rename has broken extraction in the field. Right now my only signal is my own job hunt.
- **Unit tests.** The prompt-building, cache logic, quota-update idempotency, and LinkedIn extractors all deserve tests. I've been shipping by running the extension against real LinkedIn pages and real LS test-mode payments, which is fine for solo work but will hurt the first time I break a regression I don't catch manually.
- **Multi-resume support.** Let a user store several resume profiles ("cloud engineer", "data engineer") and pick which one to score each job against, without overwriting the other. Mostly a data-model and UI change, not architecture.

## Why Terraform and not CDK or SAM

I wanted the infra to be readable by anyone who's seen Terraform once, without pulling in a huge framework. The whole `infra/` directory is ~400 lines of `.tf` and it's very easy to point at and say "that's everything". CDK and SAM are more ergonomic at 10x the scale, but they're overkill for five Lambdas and they obscure the resources behind abstractions. For a solo side project I wanted the least amount of magic between me and the AWS API.

The bootstrap pattern — a separate one-shot stack with local state that creates the S3 state bucket and DynamoDB lock table for the main stack to use — is also nice. It's lift-and-shift into any other project, and it keeps the state backend itself managed as code instead of created by hand in the console.

## Code layout

```
greenlit/
├── extension/             Chrome MV3 extension — content script, service worker, popup
│   ├── content.js         LinkedIn DOM injection, result panel, chrome.storage cache
│   ├── background.js      Service worker — Cognito auth, /analyze + billing dispatch
│   ├── popup.{html,js}    Sign-in, profile editor, usage bar, manage-billing link
│   ├── auth.js            Direct Cognito JSON RPC client (no SDK)
│   └── manifest.json      MV3 manifest, host_permissions, content script matches
│
├── backend/               TypeScript Lambda source, esbuild-bundled
│   └── src/
│       ├── handlers/
│       │   ├── analyze.ts        Quota-checked Claude call + DynamoDB cache
│       │   ├── profile.ts        GET/PUT profile; surfaces usage + billing to popup
│       │   ├── upload.ts         Server-side pdf-parse → S3 + DynamoDB
│       │   ├── lemon-billing.ts  Lemon Squeezy checkout + customer portal sessions
│       │   └── lemon-webhook.ts  HMAC-signed LS webhook → DynamoDB tier/quota sync
│       └── lib/
│           ├── anthropic.ts      Claude client + prompt-caching system block
│           ├── dynamo.ts         Typed clients, tier model, getOrInitUser, incrementUsage
│           ├── lemon.ts          Hand-rolled LS REST client + HMAC-SHA256 verifier
│           ├── auth.ts           Cognito JWT helpers
│           └── http.ts           API Gateway v2 response helpers
│
├── infra/                 Terraform stack — api gateway, lambda, cognito, dynamo, s3, iam, secrets
│   ├── *.tf               One file per resource family, ~400 lines total
│   ├── LEMONSQUEEZY.md    Dashboard setup checklist (test mode + live mode)
│   └── bootstrap/         One-shot stack that creates the tfstate bucket + lock table
│
└── docs/                  GitHub Pages — static billing success/cancel landing pages
```

---

If you're a recruiter or just curious, the README has the product pitch; this file is the "how I think about systems" side. Thanks for reading.
