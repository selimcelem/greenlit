# Greenlit

AI-powered job match scoring for LinkedIn. Green / yellow / red verdicts injected directly into the feed and job-detail pages.

## Project layout

```
greenlit/
├── extension/   Chrome extension (Manifest V3) — UI on LinkedIn
├── backend/     Node.js + TypeScript Lambdas — proxies Claude, owns the API key
└── infra/       Terraform — AWS Cognito, API Gateway, Lambda, DynamoDB, S3
```

### `extension/`
The Chrome extension users install. Talks only to our backend (never directly to Anthropic). Handles sign-in via Cognito and renders match badges on LinkedIn.

### `backend/`
TypeScript Lambdas behind API Gateway. Holds the Anthropic API key in Secrets Manager so it never lives on user machines. Reads/writes user profile, resume, and analysis cache.

### `infra/`
Terraform for the full AWS stack in `eu-central-1`. See `infra/README.md` for deploy steps.

## Status
MVP. The extension under `extension/` currently still calls Claude directly with a user-supplied key — this is being migrated to the backend.
