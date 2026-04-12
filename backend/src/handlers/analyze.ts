import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, USERS_TABLE, CACHE_TABLE } from '../lib/dynamo.js';
import { getUserId } from '../lib/auth.js';
import { ok, bad, parseJson } from '../lib/http.js';
import { scoreJob, type JobData } from '../lib/anthropic.js';

interface AnalyzeRequest {
  jobId: string;
  jobData: JobData;
}

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const userId = getUserId(event);
  if (!userId) return bad(401, 'Unauthorized');

  const body = parseJson<AnalyzeRequest>(event.body);
  if (!body?.jobId || !body.jobData) return bad(400, 'Missing jobId or jobData');

  const cached = await ddb.send(
    new GetCommand({ TableName: CACHE_TABLE, Key: { userId, jobId: body.jobId } }),
  );
  if (cached.Item?.result) return ok(cached.Item.result);

  const profile = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } }),
  );
  if (!profile.Item?.resumeText) {
    return bad(412, 'Resume not set. Upload your resume first.');
  }

  const result = await scoreJob(
    body.jobData,
    profile.Item.resumeText as string,
    (profile.Item.preferences as Record<string, string>) ?? {},
  );

  await ddb.send(
    new PutCommand({
      TableName: CACHE_TABLE,
      Item: {
        userId,
        jobId: body.jobId,
        result,
        ttl: Math.floor(Date.now() / 1000) + CACHE_TTL_SECONDS,
      },
    }),
  );

  return ok(result);
};
