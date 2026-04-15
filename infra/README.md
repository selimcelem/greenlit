# Greenlit Infra

Terraform for the full AWS stack. Region: `eu-central-1`.

## What's in here

- **Cognito User Pool** — email/password auth + optional TOTP MFA
- **API Gateway HTTP API v2** — JWT authorizer fronts the authenticated Lambdas, CORS locked to the extension origin; `/billing/webhook` is the only unauthenticated route (HMAC verified inside the Lambda)
- **Lambda** — `analyze`, `profile`, `upload`, `lemon-billing`, `lemon-webhook` (TypeScript, bundled in `../backend`)
- **DynamoDB** — `users` table (profile, resume text, tier + quota counters), `cache` table (TTL'd job analyses)
- **S3** — private bucket for original resume PDFs (TLS-only, public access blocked)
- **Secrets Manager** — holds the shared Anthropic API key, the Lemon Squeezy API key, and the LS webhook signing secret (each Lambda gets only the ARNs it actually needs)
- **CloudWatch alarms + SNS** — `AWS/Billing` estimated-charges alarm in `us-east-1`, daily Lambda invocation cap, per-function error-rate alarms, all wired to an email-subscribed SNS topic (see [`alarms.tf`](alarms.tf))
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
terraform apply -var-file=greenlit.tfvars
```

Outputs include the API Gateway base URL and Cognito User Pool / App Client IDs — paste those into `extension/config.js`.

The Lemon Squeezy API key and webhook signing secret are not in tfvars — Terraform creates the secrets with placeholder values, and you populate them via `aws secretsmanager put-secret-value` after the first apply (Terraform `ignore_changes` keeps them out of the diff). The full dashboard checklist for both test mode and live mode is in [`LEMONSQUEEZY.md`](LEMONSQUEEZY.md), including how to flip from test to live without rotating the API key.

## Variables

| Name                              | Required | Notes                                                        |
| --------------------------------- | -------- | ------------------------------------------------------------ |
| `anthropic_api_key`               | yes      | Sensitive. Stored in Secrets Manager, fetched by the Lambda. |
| `allowed_origins`                 | yes      | List of allowed origins for API GW + S3 CORS. **Must** be a real `chrome-extension://...` origin — wildcards are rejected. |
| `lemonsqueezy_store_id`           | yes      | LS store ID. Stays the same between test and live mode.       |
| `lemonsqueezy_variant_id_starter` | yes      | LS variant ID for the Starter (€3/mo) product.                |
| `lemonsqueezy_variant_id_pro`     | yes      | LS variant ID for the Pro (€6/mo) product.                    |
| `lemonsqueezy_variant_id_max`     | yes      | LS variant ID for the Max (€12/mo) product.                   |
| `region`                          | no       | Defaults to `eu-central-1`.                                  |
| `project`                         | no       | Resource name prefix, defaults to `greenlit`.                |

See `example.tfvars` for a starting template and [`LEMONSQUEEZY.md`](LEMONSQUEEZY.md) for where to find each LS ID in the dashboard.
