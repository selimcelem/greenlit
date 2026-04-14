import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, USERS_TABLE } from '../lib/dynamo.js';
import {
  getSubscription,
  isEntitled,
  tierFromVariantId,
  verifyWebhookSignature,
  type PaidTier,
} from '../lib/lemon.js';

// Lemon Squeezy webhooks are unauthenticated from the Cognito perspective
// — they come directly from LS, HMAC-SHA256-signed against our store's
// signing secret. The signature check below is the ONLY authentication
// on this endpoint, which is why it runs on the unverified raw body
// before any parsing.
//
// All LS subscription events carry `meta.custom_data` echoed from the
// original checkout (including `cognito_sub`), so we never need to look
// up a customer → user mapping. That's the big behavioural difference
// from the Stripe version this file replaces.

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const signature =
    event.headers['x-signature'] ??
    event.headers['X-Signature'];

  // API Gateway HTTP API delivers the raw body as a UTF-8 string unless
  // it decides the payload is binary, in which case it base64-encodes it
  // and sets isBase64Encoded. LS signs the literal UTF-8 bytes of the
  // JSON body, so we decode to UTF-8 before passing to the HMAC verifier.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  const ok = await verifyWebhookSignature(rawBody, signature);
  if (!ok) {
    console.error('Webhook signature verification failed');
    return text(400, 'Invalid signature');
  }

  let payload: LemonWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LemonWebhookPayload;
  } catch {
    return text(400, 'Invalid JSON');
  }

  try {
    await routeEvent(payload);
  } catch (err) {
    // Returning 5xx tells LS to retry the webhook — we want that for
    // transient DynamoDB errors so a brief outage doesn't leave the
    // user stuck on the wrong tier after a successful payment.
    console.error('Webhook handler failed', {
      event: payload.meta?.event_name,
      err:   err instanceof Error ? err.message : String(err),
    });
    return text(500, 'Handler error');
  }

  return text(200, 'ok');
};

// Webhook payloads that matter to us carry both the subscription shape
// under `data` and our custom_data under `meta`. Events we don't handle
// may have a different shape, which is fine — we never read their data.
interface LemonWebhookPayload {
  meta?: {
    event_name?:  string;
    custom_data?: {
      cognito_sub?: string;
    };
  };
  data?: {
    id?:         string | number;
    attributes?: Record<string, unknown>;
  };
}

async function routeEvent(payload: LemonWebhookPayload): Promise<void> {
  const eventName = payload.meta?.event_name;
  const cognitoSub = payload.meta?.custom_data?.cognito_sub;

  if (!eventName) {
    console.warn('Webhook missing event_name');
    return;
  }
  if (!cognitoSub) {
    // Events that aren't tied to one of our checkouts (e.g. a manual
    // order created in the dashboard). Log and ignore — we have no user
    // to attach them to, and racing to create a row for an orphan event
    // would just litter the users table.
    console.warn('Webhook missing custom_data.cognito_sub', { eventName });
    return;
  }

  const subscriptionId = payload.data?.id;
  if (!subscriptionId) {
    console.warn('Webhook missing subscription id', { eventName });
    return;
  }

  switch (eventName) {
    case 'subscription_created':
    case 'subscription_updated':
    case 'subscription_resumed':
    case 'subscription_unpaused':
    case 'subscription_payment_success': {
      // Re-fetch the subscription from the API rather than trusting the
      // webhook payload — means we always work from live source of truth
      // and dodge a whole class of "stale event delivered late" bugs.
      await syncSubscription(String(subscriptionId), cognitoSub);
      return;
    }

    case 'subscription_cancelled':
    case 'subscription_paused':
    case 'subscription_expired': {
      // `cancelled` means the user hit cancel but the period hasn't
      // ended yet — they keep access until subscription_expired fires
      // at period end. `paused` is a hold state with no access.
      // `expired` is the hard drop. All three paths go through sync
      // so the status field stays accurate; sync decides whether to
      // keep the paid tier based on isEntitled().
      await syncSubscription(String(subscriptionId), cognitoSub);
      return;
    }

    case 'subscription_payment_failed': {
      // LS has its own dunning retry flow. We log and do nothing —
      // access continues until subscription_expired fires if the
      // retries ultimately fail.
      console.log('Lemon Squeezy payment failed (retries continue)', {
        subscriptionId,
      });
      return;
    }

    default:
      // Order events, license events, and other noise fall through to
      // here. Logging at info keeps CloudWatch useful without paging
      // on each unhandled type.
      console.log('Unhandled Lemon Squeezy event', { event: eventName });
  }
}

// Pulls the latest subscription state from Lemon Squeezy and rewrites the
// matching user row in DynamoDB. Same two-update idempotency pattern as
// the former Stripe version: one unconditional update for fields that
// always overwrite, then a conditional update that only zeroes the
// monthly counter when the billing period has actually advanced. The
// conditional guard means a replayed webhook (or an unrelated
// subscription_updated for a card change) doesn't reset usage mid-cycle.
async function syncSubscription(
  subscriptionId: string,
  cognitoSub:     string,
): Promise<void> {
  const subscription = await getSubscription(subscriptionId);
  const attrs        = subscription.attributes;

  const tier: PaidTier | null = tierFromVariantId(attrs.variant_id);
  if (!tier) {
    console.error('Subscription variant_id does not match any known tier', {
      subscriptionId,
      variantId: attrs.variant_id,
    });
    return;
  }

  // Entitled = user still has paid-tier access. LS's `cancelled` status
  // stays entitled until the period ends and `expired` fires.
  const effectiveTier = isEntitled(attrs.status) ? tier : 'trial';

  // renews_at is ISO8601 from LS. For cancelled subscriptions (where
  // the user asked to cancel but hasn't hit period end yet), LS sets
  // ends_at to the period end and renews_at to null — we use ends_at
  // in that case so the quota doesn't reset to 0 while the user still
  // has access. For active subs renews_at is the next billing anchor.
  const periodEndIso = attrs.renews_at ?? attrs.ends_at;
  if (!periodEndIso) {
    console.error('Subscription has neither renews_at nor ends_at', {
      subscriptionId,
    });
    return;
  }

  // First update: fields that always take the latest value. Idempotent —
  // rerunning with the same event writes the same bytes.
  await ddb.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId: cognitoSub },
      UpdateExpression:
        'SET tier = :tier, ' +
        'lemonCustomerId = :cus, ' +
        'lemonSubscriptionId = :sub, ' +
        'subscriptionStatus = :status',
      ExpressionAttributeValues: {
        ':tier':   effectiveTier,
        ':cus':    String(attrs.customer_id),
        ':sub':    subscription.id,
        ':status': attrs.status,
      },
    }),
  );

  // Second update: counter reset only when the stored period end differs
  // from the new one, so replays and card-update events don't zero the
  // user's usage mid-cycle. ConditionalCheckFailedException on replay
  // is expected and benign.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId: cognitoSub },
        UpdateExpression:
          'SET quotaResetDate = :new, monthlyAnalyses = :zero',
        ConditionExpression:
          'attribute_not_exists(quotaResetDate) OR quotaResetDate <> :new',
        ExpressionAttributeValues: {
          ':new':  periodEndIso,
          ':zero': 0,
        },
      }),
    );
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name !== 'ConditionalCheckFailedException') throw err;
  }
}

function text(statusCode: number, body: string): APIGatewayProxyResultV2 {
  // Webhook responses don't need CORS headers — LS's server is the
  // only caller and doesn't care about browser security rules.
  return {
    statusCode,
    headers: { 'Content-Type': 'text/plain' },
    body,
  };
}
