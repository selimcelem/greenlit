import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getUserId } from '../lib/auth.js';
import { ok, bad } from '../lib/http.js';

const region = process.env.AWS_REGION ?? 'eu-central-1';
const s3 = new S3Client({ region });
const BUCKET = process.env.RESUMES_BUCKET!;
const URL_TTL_SECONDS = 300;

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const userId = getUserId(event);
  if (!userId) return bad(401, 'Unauthorized');

  const key = `resumes/${userId}/${Date.now()}.pdf`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: 'application/pdf',
    }),
    { expiresIn: URL_TTL_SECONDS },
  );

  return ok({ uploadUrl: url, key, expiresIn: URL_TTL_SECONDS });
};
