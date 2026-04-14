import * as crypto from 'node:crypto';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// ─── Secrets bootstrap ──────────────────────────────────────────────────────
// Two separate Secrets Manager ARNs, same pattern as every other secret in
// this project: the billing Lambda gets the API key only, the webhook
// Lambda gets both (API key for re-fetching subscriptions, signing secret
// for HMAC verification). Values are cached per warm container so the
// SM round-trip only runs on cold starts.

let cachedApiKeyPromise:   Promise<string> | null = null;
let cachedApiKey:          string | null = null;
let cachedSigningSecretPromise: Promise<string> | null = null;
let cachedSigningSecret:   string | null = null;

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });

async function fetchSecret(envVar: string, label: string): Promise<string> {
  const arn = process.env[envVar];
  if (!arn) throw new Error(`${envVar} is not set`);
  const result = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error(`${label} has no SecretString`);
  return result.SecretString;
}

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  if (!cachedApiKeyPromise) {
    cachedApiKeyPromise = fetchSecret('LEMON_API_KEY_SECRET_ARN', 'Lemon Squeezy API key secret');
  }
  cachedApiKey = await cachedApiKeyPromise;
  return cachedApiKey;
}

export async function getSigningSecret(): Promise<string> {
  if (cachedSigningSecret) return cachedSigningSecret;
  if (!cachedSigningSecretPromise) {
    cachedSigningSecretPromise = fetchSecret(
      'LEMON_WEBHOOK_SECRET_ARN',
      'Lemon Squeezy webhook signing secret',
    );
  }
  cachedSigningSecret = await cachedSigningSecretPromise;
  return cachedSigningSecret;
}

// ─── Tiers & config ─────────────────────────────────────────────────────────
// Lemon Squeezy does NOT support lazy product/variant creation the way
// Stripe does — product creation via API exists but is less battle-tested
// and can hit verification snags. We require the store and variant IDs to
// be provided up-front via Lambda env vars (which come from tfvars), and
// the user creates the three products in the LS dashboard by hand.

export type PaidTier = 'starter' | 'pro' | 'max';

export function variantIdForTier(tier: PaidTier): string {
  const key = `LEMON_VARIANT_ID_${tier.toUpperCase()}`;
  const id  = process.env[key];
  if (!id) throw new Error(`${key} is not set`);
  return id;
}

// Reverse lookup used by the webhook handler to turn a subscription's
// variant_id into our tier string. LS returns variant_id as a number in
// JSON but we store it as a string in env vars, so we coerce before
// comparing. Returns null for any variant that isn't one of ours — the
// webhook handler logs and ignores those, which guards us against
// receiving events for products added later in the dashboard.
export function tierFromVariantId(variantId: number | string): PaidTier | null {
  const id = String(variantId);
  if (id === process.env.LEMON_VARIANT_ID_STARTER) return 'starter';
  if (id === process.env.LEMON_VARIANT_ID_PRO)     return 'pro';
  if (id === process.env.LEMON_VARIANT_ID_MAX)     return 'max';
  return null;
}

// Maps Lemon Squeezy subscription statuses to a boolean "is the user
// currently entitled to paid-tier access". LS uses:
//   on_trial, active, paused, past_due, unpaid, cancelled, expired
// We keep the paid tier for on_trial + active + cancelled (cancelled
// means "the user asked to cancel but the period hasn't ended yet" —
// Stripe's `cancel_at_period_end: true` analogue). Everything else
// drops the user back to trial at webhook time.
export function isEntitled(status: string): boolean {
  return status === 'active' || status === 'on_trial' || status === 'cancelled';
}

// ─── HTTP client ────────────────────────────────────────────────────────────
// Hand-rolled because the official client bundles ~300 KB of code for the
// four endpoints we actually use: create checkout, retrieve subscription,
// retrieve customer (for the portal URL), and webhook signature verify
// (which doesn't even touch the API). JSON:API responses are shallow
// enough that ad-hoc types beat an SDK's generated types here.

const LEMON_API_BASE = 'https://api.lemonsqueezy.com/v1';

async function lemonRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = await getApiKey();
  const res    = await fetch(`${LEMON_API_BASE}${path}`, {
    method,
    headers: {
      Accept:        'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization:  `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    // LS error responses are JSON:API errors — stringify for the log.
    throw new Error(`Lemon Squeezy ${method} ${path} failed: ${res.status} ${text}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Lemon Squeezy ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// ─── API surfaces we actually call ──────────────────────────────────────────

// Create a hosted checkout URL for a specific variant. `custom_data` is
// the key piece: whatever we put here is echoed back on EVERY webhook
// event for the resulting subscription via `meta.custom_data`, so we
// stamp the Cognito sub onto it and that's how the webhook correlates
// events back to our user row.
export async function createCheckout(params: {
  storeId:    string;
  variantId:  string;
  email:      string | undefined;
  cognitoSub: string;
  redirectUrl: string;
}): Promise<{ url: string }> {
  type Response = {
    data: {
      attributes: {
        url: string;
      };
    };
  };

  const response = await lemonRequest<Response>('POST', '/checkouts', {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: {
          email:  params.email,
          // LS prefers snake_case keys inside custom_data. The webhook
          // receives this back as `meta.custom_data.cognito_sub`.
          custom: { cognito_sub: params.cognitoSub },
        },
        product_options: {
          redirect_url: params.redirectUrl,
        },
      },
      relationships: {
        store:   { data: { type: 'stores',   id: params.storeId } },
        variant: { data: { type: 'variants', id: params.variantId } },
      },
    },
  });

  return { url: response.data.attributes.url };
}

// Minimal subscription shape — we only read the fields we actually use.
// Whatever else LS returns is ignored. Field names match the LS JSON
// exactly so the webhook handler can just read them off the response.
export interface LemonSubscription {
  id:         string;
  attributes: {
    store_id:     number;
    customer_id:  number;
    variant_id:   number;
    status:       string;
    renews_at:    string | null;
    ends_at:      string | null;
    cancelled:    boolean;
  };
}

export async function getSubscription(
  subscriptionId: string | number,
): Promise<LemonSubscription> {
  type Response = { data: LemonSubscription };
  const response = await lemonRequest<Response>('GET', `/subscriptions/${subscriptionId}`);
  return response.data;
}

// Customer-portal URL lookup. The URL LS returns is signed and short-
// lived, so we fetch it on every portal click rather than caching on
// the user row — caching would force us to invalidate when the URL
// expires and we'd end up with stale portal links in DDB.
export async function getCustomerPortalUrl(customerId: string | number): Promise<string> {
  type Response = {
    data: {
      attributes: {
        urls: {
          customer_portal: string;
        };
      };
    };
  };
  const response = await lemonRequest<Response>('GET', `/customers/${customerId}`);
  const url = response.data.attributes.urls.customer_portal;
  if (!url) throw new Error(`Customer ${customerId} has no customer_portal URL`);
  return url;
}

// ─── Webhook signature verification ─────────────────────────────────────────
// Lemon Squeezy signs webhooks with HMAC-SHA256 of the raw request body,
// using the signing secret you set on the webhook endpoint in the
// dashboard. The signature arrives as a hex string in the `X-Signature`
// header and we verify it in constant time to dodge timing attacks.
// Different header + different algorithm from Stripe, but same concept.

export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const secret = await getSigningSecret();

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  // Both buffers must be equal length for timingSafeEqual, which means a
  // wrong-length signature would throw. Catch that up front — a signature
  // with the wrong length is simply "invalid", not an exception.
  if (expected.length !== signatureHeader.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected,        'utf8'),
      Buffer.from(signatureHeader, 'utf8'),
    );
  } catch {
    return false;
  }
}
