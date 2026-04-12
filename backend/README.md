# Greenlit Backend

TypeScript Lambdas that sit between the Chrome extension and the Anthropic API.

## Why

The MVP extension stored each user's Anthropic API key in `chrome.storage.local` and called `api.anthropic.com` directly. This backend moves that key off the user's machine: users authenticate via Cognito, the Lambda fetches the shared Anthropic key from Secrets Manager, calls Claude on their behalf, and returns the result.

## Handlers

| Route                  | Handler              | Purpose                                                  |
| ---------------------- | -------------------- | -------------------------------------------------------- |
| `POST /analyze`        | `analyze.ts`         | Score a job posting against the caller's stored resume   |
| `GET /profile`         | `profile.ts`         | Read the caller's resume text + preferences              |
| `PUT /profile`         | `profile.ts`         | Update resume text + preferences                         |
| `POST /resume/upload`  | `upload.ts`          | Issue a presigned S3 URL for uploading the original PDF  |

All routes require a valid Cognito ID token in `Authorization: Bearer ...`.

## Development

```bash
cd backend
npm install
npm run build      # bundles each handler into dist/<name>.zip via esbuild
```

`dist/*.zip` is what Terraform uploads to Lambda.

## Layout

```
backend/
├── src/
│   ├── handlers/
│   │   ├── analyze.ts
│   │   ├── profile.ts
│   │   └── upload.ts
│   └── lib/
│       ├── anthropic.ts   shared Claude client + prompt builder
│       ├── auth.ts        extracts Cognito sub from API GW JWT context
│       ├── dynamo.ts      DynamoDB document client wrapper
│       └── http.ts        small response helpers
├── build.mjs              esbuild driver
├── package.json
└── tsconfig.json
```
