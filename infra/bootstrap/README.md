# Bootstrap

One-shot Terraform stack that creates the S3 bucket and DynamoDB table the **main** `infra/` stack uses for remote state and locking.

This is a chicken-and-egg workaround: the main stack stores its state in S3, but the bucket itself has to be created somewhere — so we create it here with **local** state, then never touch it again.

## Run once

```bash
cd infra/bootstrap
terraform init
terraform apply
```

Then copy the `backend_hcl` output into `infra/backend.hcl`:

```bash
terraform output -raw backend_hcl > ../backend.hcl
```

From here on out, the main stack uses the remote backend:

```bash
cd ..
terraform init -backend-config=backend.hcl
terraform apply -var "anthropic_api_key=sk-ant-..."
```

## What it creates

- `greenlit-tfstate-<random>` — versioned, encrypted S3 bucket (TLS-only via bucket policy, public access fully blocked, `prevent_destroy = true`)
- `greenlit-tfstate-lock` — DynamoDB table with `LockID` PK, encrypted at rest, deletion-protected

## Don't `terraform destroy` this

Both resources have `lifecycle.prevent_destroy = true` and the DynamoDB table has `deletion_protection_enabled = true`. Tearing this stack down would orphan the main stack's state.
