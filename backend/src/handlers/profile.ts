import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, USERS_TABLE } from '../lib/dynamo.js';
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
    const result = await ddb.send(
      new GetCommand({ TableName: USERS_TABLE, Key: { userId } }),
    );
    return ok({
      resumeText: result.Item?.resumeText ?? '',
      preferences: result.Item?.preferences ?? {},
    });
  }

  if (method === 'PUT') {
    const body = parseJson<ProfileBody>(event.body);
    if (!body) return bad(400, 'Invalid JSON body');
    if (typeof body.resumeText !== 'string' || body.resumeText.length < 50) {
      return bad(400, 'resumeText must be at least 50 characters');
    }

    await ddb.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: {
          userId,
          resumeText: body.resumeText,
          preferences: body.preferences ?? {},
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    return ok({ saved: true });
  }

  return bad(405, `Method ${method} not allowed`);
};
