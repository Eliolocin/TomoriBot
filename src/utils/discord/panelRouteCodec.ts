/**
 * Shared route codec interfaces, primitive parsers, and codec runners for Discord panel interactions.
 * Centralizes wire-token serialization and parsing across panel route families to guarantee
 * symmetric encoding and decoding without duplicating boundary checks.
 *
 * A custom ID already living in a user's Discord client was encoded by an earlier build, so the field
 * order in a codec is a published format rather than an implementation detail. Encoding and decoding
 * walk that one ordered list, which means a field moved between positions moves both sides together:
 * every round-trip still passes while every open client breaks. Only a table of literal custom IDs
 * catches that, which is what `WIRE_CONTRACT_V2` in `tests/unit/discord/personalConfigRoutes.test.ts`
 * exists to be.
 */

export interface RouteFieldCodec<TKey extends string = string, TValue = unknown> {
  key: TKey;
  optional?: boolean;
  encode: (value: unknown) => string;
  decode: (raw: string, routeSoFar: Readonly<Record<string, unknown>>) => TValue | null;
}

export interface RouteCodec<TRoute extends Record<string, unknown> = Record<string, unknown>> {
  wireToken: string;
  fields: readonly RouteFieldCodec<keyof TRoute & string, unknown>[];
}

export function parsePositiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseNonce(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,32}$/.test(value) ? value : null;
}

export function parseSnowflake(value: string | undefined): string | null {
  if (!value || !/^\d{17,20}$/.test(value)) return null;
  return value;
}

export function indexCodecsByWireToken<TAction extends string, TRoute extends { action: TAction; locale: string }>(
  codecs: Record<TAction, { wireToken: string; fields: readonly RouteFieldCodec<string, unknown>[] }>,
): Map<string, { action: TAction; codec: RouteCodec<TRoute> }> {
  const map = new Map<string, { action: TAction; codec: RouteCodec<TRoute> }>();
  for (const [action, codec] of Object.entries(codecs) as [TAction, RouteCodec<TRoute>][]) {
    map.set(codec.wireToken, { action, codec });
  }
  return map;
}

export function buildRouteSegments<TRoute extends { action: string; locale: string }>(
  codec: { wireToken: string; fields: readonly RouteFieldCodec<string, unknown>[] },
  route: TRoute,
): string[] {
  const segments: string[] = [codec.wireToken, route.locale];
  const record = route as unknown as Record<string, unknown>;

  for (const field of codec.fields) {
    const value = record[field.key];
    if (value === undefined) {
      if (field.optional) continue;
      throw new Error(`Missing required field '${String(field.key)}' for action '${route.action}'`);
    }
    segments.push(field.encode(value));
  }

  return segments;
}

export function decodeRouteSegments<TRoute extends { action: string; locale: string }>(
  codec: { fields: readonly RouteFieldCodec<string, unknown>[] },
  action: TRoute["action"],
  locale: string,
  tail: readonly string[],
): TRoute | null {
  const requiredCount = codec.fields.filter((f) => !f.optional).length;
  const maxCount = codec.fields.length;

  if (tail.length < requiredCount || tail.length > maxCount) {
    return null;
  }

  const parsedRoute: Record<string, unknown> = { action, locale };

  for (let i = 0; i < tail.length; i++) {
    const field = codec.fields[i];
    const decoded = field.decode(tail[i], parsedRoute);
    if (decoded === null || decoded === undefined) {
      return null;
    }
    parsedRoute[field.key] = decoded;
  }

  return parsedRoute as TRoute;
}
