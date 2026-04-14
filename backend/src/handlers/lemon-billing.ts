import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { getOrInitUser } from '../lib/dynamo.js';
import { getUserId } from '../lib/auth.js';
import { ok, bad, parseJson } from '../lib/http.js';
import {
  createCheckout,
  getCustomerPortalUrl,
  variantIdForTier,
  type PaidTier,
} from '../lib/lemon.js';

// Static GitHub Pages routes under the greenlit repo's /docs folder.
// Lemon Squeezy only uses one redirect URL (on success) — there's no
// separate "canceled" URL because LS's hosted checkout has its own
// in-checkout back-out flow. We still ship billing-cancel.html for
// symmetry and future use, but the billing Lambda only points at success.
const SUCCESS_URL = 'https://selimcelem.github.io/greenlit/billing-success.html';

interface CheckoutBody {
  tier?: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const userId = getUserId(event);
  if (!userId) return bad(401, 'Unauthorized');

  const method = event.requestContext.http.method;
  const path   = event.requestContext.http.path;
  if (method !== 'POST') return bad(405, `Method ${method} not allowed`);

  // Single Lambda, two routes. Path-based routing because both routes
  // share the same Cognito auth + user init code and a single bundle
  // keeps cold-start latency down.
  if (path.endsWith('/checkout-session')) return handleCheckout(userId, event);
  if (path.endsWith('/portal-session'))   return handlePortal(userId);

  return bad(404, `No route for ${path}`);
};

async function handleCheckout(
  userId: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const body = parseJson<CheckoutBody>(event.body);
  const tier = body?.tier;
  if (tier !== 'starter' && tier !== 'pro' && tier !== 'max') {
    return bad(400, 'tier must be one of: starter, pro, max');
  }

  // We don't need to read the existing user here for the checkout call
  // itself — LS's custom_data carries the cognitoSub through every
  // webhook, so there's no customer-upsert dance to do up front. But
  // we still run getOrInitUser to lazily provision the row for brand-new
  // users, matching the pattern used by every other authenticated handler.
  await getOrInitUser(userId);

  const storeId   = requireEnv('LEMON_STORE_ID');
  const variantId = variantIdForTier(tier as PaidTier);
  const email     = readEmailClaim(event);

  const { url } = await createCheckout({
    storeId,
    variantId,
    email,
    cognitoSub:  userId,
    redirectUrl: SUCCESS_URL,
  });

  return ok({ url });
}

async function handlePortal(userId: string): Promise<APIGatewayProxyResultV2> {
  const user = await getOrInitUser(userId);
  // lemonCustomerId is written onto the user row by the webhook handler
  // on subscription_created. If it's missing, the user has never had a
  // subscription and we surface that as a 400 — the popup only shows the
  // "Manage billing" link for users where billing.hasCustomer is true,
  // so hitting this path should be rare in practice.
  const customerId = user.lemonCustomerId as string | number | undefined;
  if (!customerId) {
    return bad(400, 'No Lemon Squeezy customer on file — subscribe first.');
  }

  const url = await getCustomerPortalUrl(customerId);
  return ok({ url });
}

function readEmailClaim(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): string | undefined {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const email  = claims?.email;
  return typeof email === 'string' ? email : undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
