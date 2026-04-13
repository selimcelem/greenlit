import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
// Import from the lib entry — pdf-parse's package index.js runs a debug block
// at import time that tries to read a bundled test PDF, which fails in Lambda.
import pdf from 'pdf-parse/lib/pdf-parse.js';
import { ddb, USERS_TABLE } from '../lib/dynamo.js';
import { getUserId } from '../lib/auth.js';
import { ok, bad, parseJson } from '../lib/http.js';

const region = process.env.AWS_REGION ?? 'eu-central-1';
const s3 = new S3Client({ region });
const BUCKET = process.env.RESUMES_BUCKET!;

// API Gateway v2 caps request body at 10 MB. Base64 inflates by ~33%, so the
// raw-PDF ceiling is ~7.5 MB. Reject anything bigger before we even decode.
const MAX_PDF_BYTES = 7 * 1024 * 1024;
const MIN_TEXT_CHARS = 50;

interface UploadBody {
  filename?: string;
  contentBase64?: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const userId = getUserId(event);
  if (!userId) return bad(401, 'Unauthorized');

  const body = parseJson<UploadBody>(event.body);
  if (!body?.contentBase64) return bad(400, 'contentBase64 is required');

  let pdfBytes: Buffer;
  try {
    pdfBytes = Buffer.from(body.contentBase64, 'base64');
  } catch {
    return bad(400, 'contentBase64 is not valid base64');
  }

  if (pdfBytes.length === 0) return bad(400, 'Empty file');
  if (pdfBytes.length > MAX_PDF_BYTES) {
    return bad(413, `PDF is too large. Max ${Math.floor(MAX_PDF_BYTES / 1024 / 1024)} MB.`);
  }
  // Every PDF starts with "%PDF" — cheap sanity check before we hand the
  // bytes to the parser.
  if (pdfBytes.subarray(0, 4).toString('ascii') !== '%PDF') {
    return bad(400, 'File is not a PDF');
  }

  let resumeText: string;
  try {
    const parsed = await pdf(pdfBytes);
    resumeText = (parsed.text ?? '').trim();
  } catch (err) {
    console.error('pdf-parse failed', err);
    return bad(400, 'Could not parse PDF. Try another file or paste your resume text.');
  }

  if (resumeText.length < MIN_TEXT_CHARS) {
    return bad(
      400,
      `Extracted only ${resumeText.length} characters. The PDF may be a scanned image — paste your resume text instead.`,
    );
  }

  const key = `resumes/${userId}/${Date.now()}.pdf`;

  await s3.send(
    new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        pdfBytes,
      ContentType: 'application/pdf',
    }),
  );

  // Merge onto the existing user row so we don't clobber preferences.
  await ddb.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key:       { userId },
      UpdateExpression: 'SET resumeText = :text, resumeKey = :key, updatedAt = :now',
      ExpressionAttributeValues: {
        ':text': resumeText,
        ':key':  key,
        ':now':  new Date().toISOString(),
      },
    }),
  );

  return ok({
    resumeText,
    key,
    chars: resumeText.length,
  });
};
