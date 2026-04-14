import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, USERS_TABLE, computeUsage, getOrInitUser } from '../lib/dynamo.js';
import { getUserId } from '../lib/auth.js';
import { ok, bad, parseJson } from '../lib/http.js';
import type { Preferences } from '../lib/anthropic.js';

interface ProfileBody {
  resumeText?: string;
  preferences?: Preferences;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const userId = getUserId(event);
  if (!userId) return bad(401, 'Unauthorized');

  const method = event.requestContext.http.method;

  if (method === 'GET') {
    // getOrInitUser doubles as the signup hook: the popup hits GET /profile
    // immediately after sign-in, and that's where a brand-new user gets
    // their trial-tier row written.
    const item = await getOrInitUser(userId);
    return ok({
      resumeText:  item.resumeText ?? '',
      preferences: item.preferences ?? {},
      usage:       computeUsage(item),
      billing: {
        // The popup uses these to decide whether to show the "Manage
        // billing" link (requires a Lemon Squeezy customer on file) and
        // to surface dunning state if the subscription is past_due.
        // Field names on the response are provider-neutral so the
        // extension never needs to know which billing backend runs.
        hasSubscription: Boolean(item.lemonSubscriptionId),
        hasCustomer:     Boolean(item.lemonCustomerId),
        status:          (item.subscriptionStatus as string | undefined) ?? null,
      },
    });
  }

  if (method === 'PUT') {
    const body = parseJson<ProfileBody>(event.body);
    if (!body) return bad(400, 'Invalid JSON body');
    if (typeof body.resumeText !== 'string' || body.resumeText.length < 50) {
      return bad(400, 'resumeText must be at least 50 characters');
    }

    // Initialize quota fields first so the row exists with sane defaults
    // before we update it. This also covers the (rare) case where a user
    // hits PUT before ever calling GET.
    await getOrInitUser(userId);

    // UpdateCommand instead of PutCommand: the previous PutCommand-based
    // implementation overwrote the entire item, which would clobber tier,
    // lifetimeAnalyses, monthlyAnalyses, and quotaResetDate every time the
    // user saved their preferences.
    await ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key:       { userId },
        UpdateExpression: 'SET resumeText = :r, preferences = :p, updatedAt = :now',
        ExpressionAttributeValues: {
          ':r':   body.resumeText,
          ':p':   body.preferences ?? {},
          ':now': new Date().toISOString(),
        },
      }),
    );
    return ok({ saved: true });
  }

  return bad(405, `Method ${method} not allowed`);
};
