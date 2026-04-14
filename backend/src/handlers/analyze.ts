import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  ddb,
  CACHE_TABLE,
  computeUsage,
  getOrInitUser,
  incrementUsage,
} from '../lib/dynamo.js';
import { getUserId } from '../lib/auth.js';
import { ok, bad, json, parseJson } from '../lib/http.js';
import { scoreJob, type JobData } from '../lib/anthropic.js';

interface AnalyzeRequest {
  jobId: string;
  jobData: JobData;
  // When true, skip the cache read and re-run the model. The result still
  // gets written back to cache on success, overwriting any stale entry — so
  // callers don't need a separate DELETE to "clear" an old score.
  force?: boolean;
}

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const userId = getUserId(event);
  if (!userId) return bad(401, 'Unauthorized');

  const body = parseJson<AnalyzeRequest>(event.body);
  if (!body?.jobId || !body.jobData) return bad(400, 'Missing jobId or jobData');

  // Cache hits are free — they don't call the model and don't count against
  // the user's tier. We check before quota so a quota-exhausted user can
  // still re-view jobs they already analyzed in this billing cycle.
  if (!body.force) {
    const cached = await ddb.send(
      new GetCommand({ TableName: CACHE_TABLE, Key: { userId, jobId: body.jobId } }),
    );
    if (cached.Item?.result) return ok(cached.Item.result);
  }

  // getOrInitUser does three things in one round trip: lazily creates the
  // row for first-time users with trial defaults, backfills tier fields onto
  // legacy rows that predate quota tracking, and rolls the monthly counter
  // when the stored quotaResetDate has passed.
  const userItem = await getOrInitUser(userId);

  if (!userItem.resumeText) {
    return bad(412, 'Resume not set. Upload your resume first.');
  }

  const usage = computeUsage(userItem);
  if (usage.used >= usage.limit) {
    return json(429, {
      error:     'quota_exceeded',
      tier:      usage.tier,
      limit:     usage.limit,
      used:      usage.used,
      resetDate: usage.resetDate,
    });
  }

  let result;
  try {
    result = await scoreJob(
      body.jobData,
      userItem.resumeText as string,
      (userItem.preferences as Record<string, string>) ?? {},
    );
  } catch (err) {
    // Surface upstream model failures as a structured 502 so the extension
    // can show something useful in the badge tooltip instead of the generic
    // "Backend error 500" it would get from an uncaught handler exception.
    // Common cases: invalid Anthropic key, rate limit, unparseable response.
    const detail = err instanceof Error ? err.message : String(err);
    console.error('scoreJob failed', { userId, jobId: body.jobId, detail });
    return bad(502, `Model call failed: ${detail.slice(0, 300)}`);
  }

  // Increment the user's counter and write the cache in parallel — neither
  // depends on the other and both are write-only. A failure on either is
  // logged but does not block the response: the user already paid the model
  // call, withholding the result over a cache-write failure is the worst of
  // both worlds.
  await Promise.all([
    incrementUsage(userId),
    ddb.send(
      new PutCommand({
        TableName: CACHE_TABLE,
        Item: {
          userId,
          jobId: body.jobId,
          result,
          ttl: Math.floor(Date.now() / 1000) + CACHE_TTL_SECONDS,
        },
      }),
    ),
  ]);

  return ok(result);
};
