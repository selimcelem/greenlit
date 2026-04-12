# Greenlit Infra

Terraform for the full AWS stack. Region: `eu-central-1`.

## What's in here

- **Cognito User Pool** — email/password auth for the Chrome extension
- **API Gateway HTTP API v2** — JWT authorizer fronts the Lambdas
- **Lambda** — `analyze`, `profile`, `upload` (TypeScript, bundled in `../backend`)
- **DynamoDB** — `users` table (profile + resume text), `cache` table (job analyses, TTL)
- **S3** — private bucket for original resume PDFs
- **Secrets Manager** — holds the shared Anthropic API key
- **IAM** — least-privilege roles per Lambda

## Deploy

```bash
cd backend && npm install && npm run build   # produce dist/*.zip
cd ../infra
terraform init
terraform apply -var "anthropic_api_key=sk-ant-..."
```

Outputs include the API Gateway base URL and Cognito User Pool / App Client IDs — paste those into `extension/config.js` (created by the extension wiring step).

## State

For now, Terraform state is stored locally (`terraform.tfstate`). Move to an S3 + DynamoDB backend before sharing the project across machines — see `backend.tf` (commented out).
