# Greenlit Infra

Terraform for the full AWS stack. Region: `eu-central-1`.

## What's in here

- **Cognito User Pool** — email/password auth + optional TOTP MFA
- **API Gateway HTTP API v2** — JWT authorizer fronts the Lambdas, CORS locked to the extension origin
- **Lambda** — `analyze`, `profile`, `upload` (TypeScript, bundled in `../backend`)
- **DynamoDB** — `users` table (profile + resume text), `cache` table (TTL'd job analyses)
- **S3** — private bucket for original resume PDFs (TLS-only, public access blocked)
- **Secrets Manager** — holds the shared Anthropic API key
- **IAM** — least-privilege roles per Lambda

## First-time setup

The main stack stores its state in S3. The bucket and lock table are
created by a separate one-shot bootstrap stack:

```bash
cd infra/bootstrap
terraform init
terraform apply
terraform output -raw backend_hcl > ../backend.hcl
```

Then initialize the main stack against that backend:

```bash
cd ..
terraform init -backend-config=backend.hcl
```

## Deploy

```bash
# 1. Bundle the Lambda code
cd ../backend && npm install && npm run build

# 2. Apply the stack
cd ../infra
terraform apply \
  -var "anthropic_api_key=sk-ant-..." \
  -var 'allowed_origins=["chrome-extension://YOUR_EXTENSION_ID"]'
```

Outputs include the API Gateway base URL and Cognito User Pool / App Client IDs — paste those into `extension/config.js`.

## Variables

| Name                | Required | Notes                                                        |
| ------------------- | -------- | ------------------------------------------------------------ |
| `anthropic_api_key` | yes      | Sensitive. Stored in Secrets Manager, fetched by the Lambda. |
| `allowed_origins`   | yes      | List of allowed origins for API GW + S3 CORS. **Must** be a real `chrome-extension://...` origin — wildcards are rejected. |
| `region`            | no       | Defaults to `eu-central-1`.                                  |
| `project`           | no       | Resource name prefix, defaults to `greenlit`.                |

See `example.tfvars` for a starting template.
