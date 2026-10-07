/** Component 8: Bearer-token shape extraction for MCP authentication. */
export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}
