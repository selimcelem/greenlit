# Greenlit

AI-powered job match scoring for LinkedIn. Green, yellow, or red — right in the job detail panel.

Greenlit reads the LinkedIn job you're looking at, compares it against your resume using Claude, and drops a score and a short verdict into the page. No more wasting an afternoon on a job that was never going to happen, and no more guessing whether "junior" really means junior. Apply with signal, not hope.

## How it works

1. **Install the extension.** Load it in Chrome (Web Store listing coming soon — see install instructions below).
2. **Upload your resume.** Click the Greenlit icon in the toolbar, create an account, drop in a PDF. Greenlit parses the text server-side and stores it encrypted in AWS.
3. **Browse LinkedIn.** On any job detail page, click **Analyze with Greenlit**. You'll get a score (0–100), a one-line verdict, and a breakdown across seniority, skills, location, and experience. Re-analyze anytime.

## Tech stack

- **Extension:** Chrome Manifest V3 (content script + service worker + popup), vanilla JavaScript — no framework. Results are cached client-side in `chrome.storage.local` with a 7-day TTL so re-views of jobs you've already analyzed are instant and free.
- **Backend:** Five TypeScript Lambdas (Node 20, arm64), bundled with esbuild, behind API Gateway v2 HTTP API.
- **AI:** Anthropic Claude (Haiku) with prompt caching on the system instructions + resume block.
- **Auth:** AWS Cognito User Pools (email + password), JWT authorizer on every authenticated backend route.
- **Data:** DynamoDB for user profiles, quota counters, and the analysis cache (30-day TTL); S3 for resume PDFs.
- **Billing:** [Lemon Squeezy](https://www.lemonsqueezy.com/) (Merchant of Record for EU VAT) — hosted Checkout + Customer Portal + HMAC-signed webhooks that drive tier updates in DynamoDB.
- **Quota:** Per-user tier enforcement (trial lifetime cap + paid monthly caps), with counters on the user row and billing-anchor-aligned resets driven by webhooks.
- **Secrets:** AWS Secrets Manager holds the Anthropic API key, the Lemon Squeezy API key, and the webhook signing secret — the extension never sees any of them.
- **Infrastructure:** Terraform, with remote state in S3 and a DynamoDB lock table.

## Install (unpacked)

Until the Chrome Web Store listing is live (submission in review):

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome and enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Click the Greenlit icon in the toolbar, create an account, and upload your resume (PDF).
5. Open any LinkedIn job page and click **Analyze with Greenlit**.

You'll need a running backend to actually get scores. If you want to self-host the full stack, see [`infra/README.md`](infra/README.md) for the Terraform deploy steps — the whole thing fits on a free-tier AWS account for personal use.

There's also a small public landing page at [selimcelem.github.io/greenlit](https://selimcelem.github.io/greenlit/) (served from [`docs/`](docs/) via GitHub Pages) — that's where the Chrome Web Store listing will point on launch, and it links to the [privacy policy](https://selimcelem.github.io/greenlit/privacy.html).

## Privacy

The full policy is published at [selimcelem.github.io/greenlit/privacy.html](https://selimcelem.github.io/greenlit/privacy.html) — the short version:

- Your resume PDF and the extracted text are stored in AWS (S3 for the PDF, DynamoDB for the text) in `eu-central-1`, encrypted at rest. The S3 bucket is private, public access is blocked, and all traffic is TLS-only.
- Scoring calls go to Anthropic's API. Each call sees only your resume text and the specific job posting — no identity, no account info, no tracking.
- The extension never talks to Anthropic directly. If it did, your API key would have to live on your machine, which is exactly the failure mode Greenlit exists to avoid. All model calls are proxied through our backend, which holds the shared key in AWS Secrets Manager.
- No analytics, no trackers, no ad network. Greenlit doesn't know what jobs you looked at after the fact, and the browsing history stays on your machine.
- Sign out and your local tokens are wiped. Ask and your stored profile is deleted.

## Plans

- **Trial — free.** 10 analyses lifetime. Enough to try it out.
- **Starter — €3 / month.** 100 analyses per month.
- **Pro — €6 / month.** 300 analyses per month.
- **Max — €12 / month.** 1000 analyses per month.

All paid plans are billed monthly in EUR via Lemon Squeezy, VAT included, cancel anytime. Cached re-views of jobs you've already analyzed don't count against your quota.

## Coming soon

- **Chrome Web Store release** — one-click install, no developer mode required.
- **Multiple resume profiles** — swap between "cloud engineer" and "data engineer" depending on what you're applying to, without overwriting the other one.

## License

See [`LICENSE`](LICENSE).
