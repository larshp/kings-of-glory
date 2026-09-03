import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'kings_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

interface SessionClaims {
  readonly playerId: string;
  readonly expiresAt: number;
  readonly nonce: string;
}

const signatureFor = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

export const issueSession = (
  secret: string,
  now = Date.now(),
  playerId = `player-${randomUUID()}`,
) => {
  const claims: SessionClaims = {
    playerId,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1_000,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signatureFor(payload, secret)}`;
};

export const verifySession = (
  token: string | undefined,
  secret: string,
  now = Date.now(),
): SessionClaims | undefined => {
  if (!token || token.length > 1_024) return undefined;
  const separator = token.lastIndexOf('.');
  if (separator < 1) return undefined;
  const payload = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = Buffer.from(signatureFor(payload, secret), 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<SessionClaims>;
    if (
      typeof claims.playerId !== 'string' ||
      !/^player-[0-9a-f-]{36}$/.test(claims.playerId) ||
      typeof claims.expiresAt !== 'number' ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.expiresAt <= now ||
      typeof claims.nonce !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(claims.nonce)
    )
      return undefined;
    return claims as SessionClaims;
  } catch {
    return undefined;
  }
};

export const sessionTokenFromCookie = (cookieHeader: string | undefined): string | undefined => {
  if (!cookieHeader || cookieHeader.length > 8_192) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=');
  }
  return undefined;
};

export const sessionCookie = (token: string, secure: boolean) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`;
