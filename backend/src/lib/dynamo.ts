import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const region = process.env.AWS_REGION ?? 'eu-central-1';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const USERS_TABLE = process.env.USERS_TABLE!;
export const CACHE_TABLE = process.env.CACHE_TABLE!;

// ─── Tiers / quota ──────────────────────────────────────────────────────────

export type Tier = 'trial' | 'starter' | 'pro' | 'max' | 'dev';

export interface TierConfig {
  limit:    number;
  // Trial counts against a lifetime cap; paid tiers reset on the 1st of
  // every month. Treating this as a per-tier flag (rather than a string
  // enum) keeps the quota-check call sites branch-free.
  lifetime: boolean;
}

export const TIER_LIMITS: Record<Tier, TierConfig> = {
  trial:   { limit: 10,      lifetime: true  },
  starter: { limit: 100,     lifetime: false },
  pro:     { limit: 300,     lifetime: false },
  max:     { limit: 1000,    lifetime: false },
  // Internal-only tier for local/dev testing. Not exposed in any upgrade
  // flow — set manually via the DynamoDB CLI when you need an effectively
  // unlimited quota. Kept on the monthly schedule so the counter naturally
  // resets on the 1st and the usage bar still exercises the monthly path.
  dev:     { limit: 999999,  lifetime: false },
};

export interface UsageView {
  tier:      Tier;
  used:      number;
  limit:     number;
  remaining: number;
  resetDate: string | null; // null for trial (lifetime-only)
}

// First day of the month AFTER `from`, at UTC midnight. Used as the next
// reset boundary for monthly tiers. UTC keeps the boundary consistent across
// users in different timezones — "the 1st" means the same instant for all.
export function nextMonthlyReset(from: Date = new Date()): string {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1),
  ).toISOString();
}

function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && v in TIER_LIMITS;
}

export function computeUsage(item: Record<string, unknown>): UsageView {
  const tier = isTier(item.tier) ? item.tier : 'trial';
  const cfg  = TIER_LIMITS[tier];
  const used = cfg.lifetime
    ? Number(item.lifetimeAnalyses ?? 0)
    : Number(item.monthlyAnalyses ?? 0);
  return {
    tier,
    used,
    limit:     cfg.limit,
    remaining: Math.max(0, cfg.limit - used),
    resetDate: cfg.lifetime ? null : ((item.quotaResetDate as string | undefined) ?? null),
  };
}

// Reads the user row, lazily initializing it for new users (default = trial)
// and backfilling tier/usage fields onto rows that predate this feature.
// Also rolls the monthly counter when the stored quotaResetDate has passed,
// so the very next /analyze call after the 1st of the month sees a clean
// counter without needing a separate scheduled job.
export async function getOrInitUser(
  userId: string,
): Promise<Record<string, unknown>> {
  const existing = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } }),
  );

  let item = existing.Item;

  if (!item) {
    const fresh: Record<string, unknown> = {
      userId,
      tier:             'trial',
      lifetimeAnalyses: 0,
      monthlyAnalyses:  0,
      quotaResetDate:   nextMonthlyReset(),
      createdAt:        new Date().toISOString(),
    };
    try {
      await ddb.send(
        new PutCommand({
          TableName: USERS_TABLE,
          Item: fresh,
          // Guard against the race where two requests for the same brand-new
          // user land on different containers and both try to create the row.
          ConditionExpression: 'attribute_not_exists(userId)',
        }),
      );
      return fresh;
    } catch (err: unknown) {
      const name = (err as { name?: string } | null)?.name;
      if (name !== 'ConditionalCheckFailedException') throw err;
      // Lost the race — re-read whatever the winning request wrote.
      const reread = await ddb.send(
        new GetCommand({ TableName: USERS_TABLE, Key: { userId } }),
      );
      item = reread.Item ?? fresh;
    }
  }

  // Backfill quota fields onto rows that existed before this feature shipped.
  // if_not_exists on each field means we never clobber values another
  // concurrent backfill may have already written.
  if (item!.tier === undefined) {
    const defaults = {
      tier:             'trial' as Tier,
      lifetimeAnalyses: 0,
      monthlyAnalyses:  0,
      quotaResetDate:   nextMonthlyReset(),
    };
    await ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId },
        UpdateExpression:
          'SET tier = if_not_exists(tier, :t), ' +
          'lifetimeAnalyses = if_not_exists(lifetimeAnalyses, :z), ' +
          'monthlyAnalyses = if_not_exists(monthlyAnalyses, :z), ' +
          'quotaResetDate = if_not_exists(quotaResetDate, :r)',
        ExpressionAttributeValues: {
          ':t': defaults.tier,
          ':z': 0,
          ':r': defaults.quotaResetDate,
        },
      }),
    );
    Object.assign(item!, defaults);
  }

  // NOTE: paid-tier quota resets are driven exclusively by Stripe webhooks
  // (invoice.paid / customer.subscription.updated). The webhook handler
  // writes the new `quotaResetDate = current_period_end` and zeros
  // `monthlyAnalyses` only when the period actually advances. We used to
  // do a calendar-based rollover here; that was removed when Stripe went
  // live because it would clobber the billing-anchor-aligned reset date
  // the webhook sets. Trial tier never resets at all (lifetime quota).

  return item!;
}

// Increments BOTH counters on every successful analysis. The trial check
// reads `lifetimeAnalyses`; paid tiers read `monthlyAnalyses`. We bump both
// so a tier upgrade later doesn't carry stale trial counts forward, and so
// we always have a lifetime number for analytics.
export async function incrementUsage(userId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: 'ADD lifetimeAnalyses :one, monthlyAnalyses :one',
      ExpressionAttributeValues: { ':one': 1 },
    }),
  );
}
