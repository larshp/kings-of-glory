import { describe, expect, it } from 'vitest';
import {
  issueSession,
  SESSION_COOKIE,
  sessionCookie,
  sessionTokenFromCookie,
  verifySession,
} from '../src/auth.js';

const secret = 'a-production-strength-session-secret-value';
const playerId = 'player-12345678-1234-1234-1234-123456789abc';

describe('signed sessions', () => {
  it('round-trips authenticated identity and rejects expiry or tampering', () => {
    const token = issueSession(secret, 1_000, playerId);
    expect(verifySession(token, secret, 1_001)?.playerId).toBe(playerId);
    expect(verifySession(`${token.slice(0, -1)}x`, secret, 1_001)).toBeUndefined();
    expect(verifySession(token, `${secret}-wrong`, 1_001)).toBeUndefined();
    expect(verifySession(token, secret, 1_000 + 31 * 24 * 60 * 60 * 1_000)).toBeUndefined();
  });

  it('extracts only the bounded named cookie and emits hardened production attributes', () => {
    const token = issueSession(secret, 1_000, playerId);
    expect(sessionTokenFromCookie(`other=1; ${SESSION_COOKIE}=${token}; theme=dark`)).toBe(token);
    expect(sessionTokenFromCookie('x'.repeat(8_193))).toBeUndefined();
    expect(sessionCookie(token, true)).toContain('HttpOnly; SameSite=Strict');
    expect(sessionCookie(token, true)).toContain('; Secure');
  });
});
