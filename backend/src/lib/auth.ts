import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

export function getUserId(event: APIGatewayProxyEventV2WithJWTAuthorizer): string | null {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  return typeof sub === 'string' ? sub : null;
}
