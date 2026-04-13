# Building Greenlit

Notes on how I built Greenlit — a Chrome extension that scores LinkedIn job postings against your resume using Claude — and the decisions I made along the way. This is a portfolio write-up, so it's first-person and honest about tradeoffs.

## The problem

I'm a career switcher, moving out of BIM engineering and into cloud / devops / software. LinkedIn's job feed is a firehose: postings look promising for about two seconds, then reveal a "5+ years of Kubernetes in production" requirement I don't have. I was wasting whole evenings clicking through jobs that were never going to happen, and I noticed I was getting less honest with myself the longer I scrolled.

I wanted a tool that would read a job posting, compare it against my actual resume, and tell me — brutally, not nicely — whether it's worth applying. "Apply with signal, not hope" became the design brief.

The first version of Greenlit was a throwaway Chrome extension with a textarea where the user pasted their own Anthropic API key, plus a 60-line regex-based PDF parser running in the browser. It worked for me, which was the whole point. But "paste your API key into a textarea" is not something I'd ever ship to another human, and the PDF parser broke on almost every resume I tried that wasn't mine. So I rebuilt it properly.

## Architecture

What the stack looks like now:

- **Chrome Extension (Manifest V3), vanilla JS.** Content script on LinkedIn job pages, service worker for backend calls and auth, popup for profile editing and sign-in. The content script never touches Anthropic — it only talks to the service worker, which only talks to our backend.
- **Three AWS Lambdas, TypeScript on arm64**, bundled with esbuild into individual zips:
  - `analyze` — fetches the user's profile, calls Claude, caches the verdict.
  - `profile` — GET/PUT for the user profile (resume text + preferences).
  - `upload` — accepts a base64-encoded PDF, runs server-side text extraction via `pdf-parse`, writes the original PDF to S3, merges the extracted text onto the user row.
- **API Gateway v2 HTTP API** with a **Cognito JWT authorizer** on every route. No unauthenticated endpoints exist.
- **AWS Cognito User Pool** for email + password auth. The extension talks to `cognito-idp.eu-central-1.amazonaws.com` directly via the JSON RPC API (`SignUp`, `ConfirmSignUp`, `InitiateAuth`, `ResendConfirmationCode`). No SDK, so the bundled extension stays tiny.
- **DynamoDB** with two tables: `users` (profile + resume text, keyed on the Cognito `sub`) and `cache` (analysis results keyed on `(userId, jobId)` with a 30-day TTL on the item).
- **S3** for the raw resume PDFs. Encrypted at rest (AES256), bucket policy denies any request without TLS, public access fully blocked, versioning off because the PDFs are disposable.
- **AWS Secrets Manager** holds the shared Anthropic API key. Lambdas fetch it once per cold start and cache it in the container for the remainder of the container's life.
- **Terraform** for everything. Remote state in S3 with a DynamoDB lock table — bootstrapped from a separate one-shot Terraform stack so the state bucket itself is managed as code rather than created by hand.

The thing I care about most in this architecture is a single sentence: **the extension is dumb and the backend holds the keys.** Every pattern where a browser extension carries a third-party API key is one credential leak away from a billing disaster. Users trust Greenlit with a login, not a key, and that's the right contract.

## Security decisions

I tried to treat this like a real product even though it's a side project. Notes on what I did and why:

**Anthropic API key in Secrets Manager.** The key is a `TF_VAR_anthropic_api_key` passed at apply time, landing in a `SecretString`. Lambdas fetch it at cold start via `secretsmanager:GetSecretValue`, cache it in a module-level variable for the container lifetime, and never persist it to disk. The key never appears in the Lambda package, the environment variables, or the logs.

**Least-privilege IAM, one role per Lambda.** Each function has its own IAM role with an inline policy listing exactly the resources it needs by ARN. `analyze` gets GetItem/PutItem on the users and cache tables and GetSecretValue on the Anthropic secret — nothing else. `profile` gets GetItem/PutItem only on the users table. `upload` gets PutObject scoped to `resumes/*` on the resume bucket, UpdateItem on the users table, and nothing else. No Lambda in this stack has `s3:*`, `dynamodb:*`, or `logs:CreateLogGroup`. Log groups are pre-created by Terraform so the Lambdas only need `logs:PutLogEvents` on their own group.

**Encrypted, private resume bucket.** AES256 at rest, TLS-only via a bucket policy that denies `s3:*` when `aws:SecureTransport` is false, public access block fully enforced. The bucket name has a random suffix so it can't be guessed.

**Cognito JWT on every backend route.** API Gateway validates the token before invocation. The Lambdas read the `sub` claim off `event.requestContext.authorizer.jwt.claims` and never trust any identity field from the request body.

**Thoughtful CORS.** API Gateway allows `["*"]` because Chrome extensions bypass CORS entirely via `host_permissions` in the manifest — pinning the origin there adds no protection and just creates a deploy-time chicken-and-egg with the extension ID. But the S3 resume bucket CORS is pinned to the real extension ID, because the browser talks to S3 directly for the presigned PUT path and that request does honor CORS.

**Terraform state protection.** The state bucket has versioning, encryption, and `lifecycle.prevent_destroy = true`. The DynamoDB lock table has `deletion_protection_enabled = true`. `terraform destroy` on the main stack won't orphan the state; `terraform destroy` on the bootstrap stack will refuse to run at all.

## Technical challenges worth talking about

### 1. LinkedIn is a SPA and its DOM isn't stable

LinkedIn swaps the job detail panel in place when you click a different card — no URL change, no page load, no `popstate` event. My first pass at "inject a badge when a job detail is on screen" just checked `document.querySelector('.jl-detail-panel')` and bailed if something was already rendered. Result: the first job's score pinned to the page, stale through the next ten jobs the user clicked on.

The fix was to tag each rendered panel with a `data-jl-job-id` attribute and compare it against the *current* job ID on every MutationObserver tick. If they mismatch, the stale panel gets removed and a fresh one goes in. Any in-flight analysis on the old panel becomes a no-op when it resolves, because `panel.replaceWith()` on a detached node does nothing in modern DOM. The observer is debounced at 600 ms so LinkedIn's own DOM churn doesn't trigger a re-render on every mutation.

LinkedIn also uses a mix of class names (`jobs-unified-top-card__*`, `job-details-jobs-unified-top-card__*`) depending on which A/B test the user is in, so every selector has three or four fallback variants. This layer is going to break when LinkedIn renames things, and I've accepted that — when it does, it's a CSS-selector patch, not an architecture change.

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

### 4. Prompt caching and the cache strategy

Claude supports prompt caching with a 5-minute TTL on blocks marked `cache_control: { type: 'ephemeral' }`. The resume text plus the career-switcher instructions are the biggest chunk of every analysis prompt, and they're identical across every call for a given user. I structured the system block as `[SYSTEM_INSTRUCTIONS, resumeBlock]` and marked only the resume block as ephemeral. Because cache markers cover everything up to and including the marked block, this caches the entire static prefix (instructions + per-user resume) in a single chunk. Every subsequent call only pays full tokens for the job posting itself, which is small.

On top of that, DynamoDB stores every successful analysis in a cache table keyed on `(userId, jobId)` with a 30-day TTL, so scrolling past the same job twice costs zero API calls. A `force: true` flag on `POST /analyze` lets the user bypass the cache read and re-run from scratch — wired to a "Re-analyze" button in the result panel. The fresh result overwrites the stale entry on the cache PUT, so I didn't need a separate cache-delete endpoint or any new IAM surface.

**The biggest cost mistake I made and then fixed.** The first version of the content script injected a badge on every visible job card in the LinkedIn feed and fired an `/analyze` call for each. On a single scroll, that was 20+ parallel Anthropic calls. I watched my CloudWatch invocation graph spike into a wall and immediately ripped feed-card analysis out entirely. The extension now only scores the open job detail panel, and only when the user clicks an explicit "Analyze with Greenlit" button. Passive browsing is free. The MVP had the right idea (automatic badges everywhere) but the wrong cost model — I'd rather make the user click.

## What I'd do next

- **Rate limiting per user.** A signed-in user can still hammer `/analyze` until the Anthropic bill gets ugly. The clean path is a daily usage counter field on the user row, read and enforced in the `analyze` handler before the model call, with a daily reset via a TTL or a scheduled Lambda. This is also the natural hook for the Pro tier.
- **Chrome Web Store release.** The extension is ready except for the store chores — screenshots at the right sizes, description, privacy disclosure, proper icon assets. This is a week of polish, not engineering.
- **Payment integration.** Stripe or Lemon Squeezy for Greenlit Pro. Webhook → DynamoDB flag on the user row → the rate-limiter reads a different limit based on the flag. Billing state stays completely off the extension.
- **DOM selector resilience.** A richer set of fallback selectors, plus anonymous telemetry (on purpose, with an opt-out) so I know when a LinkedIn class rename has broken extraction. Right now the only way I find out is my own job hunt.
- **Unit tests.** The prompt-building, cache logic, and LinkedIn extractors deserve tests. I've been shipping by running it on real LinkedIn pages, which is fine for solo work but will hurt the first time I break a regression.
- **Multi-resume support.** Let a user store several resume profiles ("cloud engineer", "data engineer") and pick which one to score each job against, without overwriting the other. Mostly a data-model and UI change, not architecture.

## Why Terraform and not CDK or SAM

I wanted the infra to be readable by anyone who's seen Terraform once, without pulling in a huge framework. The whole `infra/` directory is roughly 300 lines of `.tf` and it's very easy to point at and say "that's everything". CDK and SAM are more ergonomic at 10x the scale, but they're overkill for three Lambdas and they obscure the resources behind abstractions. For a solo side project I wanted the least amount of magic between me and the AWS API.

The bootstrap pattern — a separate one-shot stack with local state that creates the S3 state bucket and DynamoDB lock table for the main stack to use — is also nice. It's lift-and-shift into any other project, and it keeps the state backend itself managed as code instead of created by hand in the console.

## Code layout

```
greenlit/
├── extension/      Chrome MV3 extension — content script, service worker, popup
├── backend/        TypeScript Lambda source, esbuild-bundled
│   └── src/
│       ├── handlers/    analyze, profile, upload
│       └── lib/         anthropic client, dynamo client, auth helper, http helpers
└── infra/          Terraform stack — api gateway, lambda, cognito, dynamo, s3, iam, secrets
    └── bootstrap/  One-shot stack that creates the tfstate bucket + lock table
```

---

If you're a recruiter or just curious, the README has the product pitch; this file is the "how I think about systems" side. Thanks for reading.
