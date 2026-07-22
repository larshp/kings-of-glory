import { describe, expect, it } from 'vitest';
import { parseAdministrativeCliArguments } from '../src/admin.js';

describe('administrative CLI arguments', () => {
  it('parses bounded inspection and mutation commands', () => {
    expect(parseAdministrativeCliArguments(['inspect', 'player', 'player-a'])).toEqual({
      type: 'inspect',
      request: { scope: 'player', id: 'player-a' },
    });
    expect(parseAdministrativeCliArguments(['inspect', 'audits', '25'])).toEqual({
      type: 'inspect-audits',
      limit: 25,
    });
    expect(
      parseAdministrativeCliArguments(['mutate', 'set-player-inventory', 'player-a', 'ingot', '4']),
    ).toEqual({
      type: 'mutate',
      mutation: { type: 'setPlayerInventory', playerId: 'player-a', item: 'ingot', amount: 4 },
    });
    expect(
      parseAdministrativeCliArguments([
        'mutate',
        'set-settlement-owner',
        'settlement-player-a',
        'player-b',
      ]),
    ).toMatchObject({ type: 'mutate', mutation: { type: 'setSettlementOwner' } });
  });

  it('rejects incomplete or unknown operations before opening a database', () => {
    expect(() => parseAdministrativeCliArguments(['inspect', 'player'])).toThrow(
      'Missing argument',
    );
    expect(() =>
      parseAdministrativeCliArguments(['mutate', 'set-player-inventory', 'player-a', 'gold', '1']),
    ).toThrow('Unknown item');
    expect(() => parseAdministrativeCliArguments(['mutate', 'unknown'])).toThrow('Usage');
  });
});
