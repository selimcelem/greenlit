# Lemon Squeezy setup checklist

One-time setup steps you need to do **in the Lemon Squeezy dashboard**,
separated by test mode and live mode. None of these are managed by
Terraform — the dashboard is the source of truth for account settings.
After each step, come back and tick the box.

## Test mode setup

LS has a test-mode toggle on the store. Flip it on at the dashboard top
(the yellow "Test mode" banner should appear) before creating any products
in this section. Everything you create in test mode is segregated from
live mode and won't appear to real buyers.

- [ ] **Toggle the store into test mode** → top-right toggle, confirm the
      yellow banner is visible.

- [ ] **Create the three Greenlit products** → Products → + New product.
      Create each one with:
      - **Name**: `Greenlit Starter`, `Greenlit Pro`, `Greenlit Max`
      - **Type**: Subscription
      - **Interval**: Monthly
      - **Price**: €3, €6, €12 respectively (these are the headline prices
        the extension renders in the upgrade panel — keep them in sync with
        `extension/content.js`'s `renderTierOption` calls)
      - **Pricing mode**: **Tax exclusive** (the extension's quota panel
        says "EUR, billed monthly. VAT added at checkout." — LS will add
        the buyer's local VAT on top of the ticket price at checkout)
      - **Currency**: EUR (should match your store's base currency)
      - **Status**: Published

- [ ] **Grab the four IDs** and put them in your tfvars file:
      - `lemonsqueezy_store_id` — Dashboard URL shows `/stores/<id>`, or
        Settings → Stores → your store
      - `lemonsqueezy_variant_id_starter` — click the Starter product, then
        its Variants tab, copy the variant ID
      - `lemonsqueezy_variant_id_pro` — same path for Pro
      - `lemonsqueezy_variant_id_max` — same path for Max

- [ ] **Create an API key** → Settings → API → + Create API key. Copy the
      token (you see it once) and put it in Secrets Manager:
      ```bash
      AWS_PROFILE=greenlit aws secretsmanager put-secret-value \
        --secret-id greenlit/lemonsqueezy-api-key \
        --region eu-central-1 \
        --secret-string 'your_api_key_here'
      ```

      LS API keys are NOT mode-specific — the same key works in test and
      live mode. Mode is a per-store setting.

- [ ] **Create the webhook endpoint** → Settings → Webhooks → + Add
      webhook. The URL is your API Gateway URL + `/billing/webhook` —
      Terraform outputs `api_base_url` after apply. Full pattern:
      ```
      https://<api-id>.execute-api.eu-central-1.amazonaws.com/billing/webhook
      ```
      Set a signing secret (LS calls it the "Webhook signing secret" — any
      random string; LS uses this to HMAC-sign the payload). Save it and
      put it in Secrets Manager:
      ```bash
      AWS_PROFILE=greenlit aws secretsmanager put-secret-value \
        --secret-id greenlit/lemonsqueezy-webhook-secret \
        --region eu-central-1 \
        --secret-string 'your_signing_secret_here'
      ```

      Select events (at minimum, all of these — the Lambda ignores the
      ones it doesn't handle but needs the ones it does):
      - `subscription_created`
      - `subscription_updated`
      - `subscription_cancelled`
      - `subscription_resumed`
      - `subscription_expired`
      - `subscription_paused`
      - `subscription_unpaused`
      - `subscription_payment_success`
      - `subscription_payment_failed`

- [ ] **Trigger a cold start on both LS Lambdas** so they pick up the real
      secret values (Secrets Manager values are cached per container):
      ```bash
      AWS_PROFILE=greenlit aws lambda update-function-configuration \
        --function-name greenlit-lemon-billing --region eu-central-1 \
        --environment "Variables={USERS_TABLE=greenlit-users,LEMON_API_KEY_SECRET_ARN=<ARN>,LEMON_STORE_ID=<ID>,LEMON_VARIANT_ID_STARTER=<ID>,LEMON_VARIANT_ID_PRO=<ID>,LEMON_VARIANT_ID_MAX=<ID>,LEMON_BUMP=1}"
      # Repeat for greenlit-lemon-webhook (include LEMON_WEBHOOK_SECRET_ARN,
      # drop LEMON_STORE_ID which the webhook doesn't need).
      ```

      Or simply redeploy the Lambda bundles via terraform apply — any
      config change terminates warm containers. Do NOT omit the existing
      env vars when you bump.

- [ ] **Smoke test end-to-end**:
      1. Open the extension on a LinkedIn job you haven't analyzed.
      2. Burn through trial quota (or manually set tier=trial with
         lifetimeAnalyses=10 via the DynamoDB CLI).
      3. Click the Starter button on the quota panel.
      4. Pay with a test card (LS publishes the full list, but
         `4242 4242 4242 4242` works).
      5. Confirm redirect to billing-success.html.
      6. Confirm the LS dashboard shows a new test subscription.
      7. Confirm the webhook delivered successfully (Settings → Webhooks →
         click the endpoint → Recent deliveries).
      8. Query DynamoDB to confirm your row now has `tier=starter`,
         `lemonCustomerId`, `lemonSubscriptionId`, `subscriptionStatus=active`,
         and a future `quotaResetDate`.

## Going live (live mode)

When you're ready to flip to live mode, **repeat every step above** in
live mode (toggle off test mode first). Specifically:

- [ ] **Create the three products in live mode** — test-mode products are
      separate entities and do not exist in live mode. You'll get new
      variant IDs.
- [ ] **Update tfvars** with the live variant IDs (store ID stays the
      same). Re-apply Terraform to push the new env vars to the Lambdas.
- [ ] **Create a live-mode webhook endpoint** pointing at the same URL
      (`/billing/webhook`). You get a new signing secret.
- [ ] **Rotate both secrets** in Secrets Manager (`lemonsqueezy-api-key`
      can stay the same — it's not mode-specific — but rotate it anyway
      if this is your first live deploy for security hygiene).
- [ ] **Cold-start the Lambdas** as above.
- [ ] **Smoke test again** with a real card on a throwaway Cognito
      account.

## Troubleshooting

- **Webhook delivery failing with 400 "Invalid signature"** — the
  `greenlit/lemonsqueezy-webhook-secret` value doesn't match the
  signing secret you set on the webhook endpoint in the dashboard.
  Re-read the secret in the LS dashboard, put it back into Secrets
  Manager, then cold-start the webhook Lambda.

- **Checkout fails with "tier must be one of..."** — the extension is
  sending an unrecognised tier name. Make sure you're on the latest
  extension build.

- **Webhook fires but DynamoDB row doesn't update** — most likely
  `meta.custom_data.cognito_sub` is missing. This happens if the
  subscription was created outside of the Greenlit checkout flow
  (e.g. manually via the LS dashboard). The Lambda logs `"Webhook
  missing custom_data.cognito_sub"` in CloudWatch. Cancel and re-
  subscribe through the extension.

- **`subscription_updated` not updating tier** — check that the
  subscription's `variant_id` matches one of your tfvars entries.
  If you created a new variant in the dashboard without updating
  tfvars + re-applying Terraform, the Lambda will log
  `"Subscription variant_id does not match any known tier"` and
  leave the row alone. Add the variant ID and re-apply.

- **"LEMON_STORE_ID is not set" in billing Lambda logs** — you
  haven't populated the tfvars entries yet. Fill them in and run
  `terraform apply`.
