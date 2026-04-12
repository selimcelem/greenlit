import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const region = process.env.AWS_REGION ?? 'eu-central-1';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const USERS_TABLE = process.env.USERS_TABLE!;
export const CACHE_TABLE = process.env.CACHE_TABLE!;
