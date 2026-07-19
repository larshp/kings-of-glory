import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/index.js';

describe('client message validation', () => {
  it('accepts a fully shaped command', () => {
    const message = {
      type: 'command',
      command: { id: 'gather-1', playerId: 'player-a', sequence: 1, type: 'gather', x: 2, y: 3 },
    };
    expect(parseClientMessage(JSON.stringify(message))).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'workshop-1',
            playerId: 'player-a',
            sequence: 2,
            type: 'placeWorkshop',
            x: 3,
            y: 4,
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'hearth-1',
            playerId: 'player-a',
            sequence: 3,
            type: 'placeHearth',
            x: 3,
            y: 4,
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
  });
  it('accepts settlement commands only with safe identifiers and known roles', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'invite-1',
            playerId: 'player-a',
            sequence: 1,
            type: 'inviteToSettlement',
            settlementId: 'settlement-player-a',
            targetPlayerId: 'player-b',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'role-1',
            playerId: 'player-a',
            sequence: 2,
            type: 'setSettlementRole',
            settlementId: 'settlement-player-a',
            targetPlayerId: 'player-b',
            role: 'owner',
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'transfer-owner-1',
            playerId: 'player-a',
            sequence: 3,
            type: 'transferSettlementOwnership',
            settlementId: 'settlement-player-a',
            targetPlayerId: 'player-b',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'remove-member-1',
            playerId: 'player-a',
            sequence: 4,
            type: 'removeSettlementMember',
            settlementId: 'settlement-player-a',
            targetPlayerId: 'player-b',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
  });
  it('accepts only the defined logistics-link shape', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'link-1',
            playerId: 'player-a',
            sequence: 1,
            type: 'createLogisticsLink',
            sourceBuildingId: 'storage-1',
            targetBuildingId: 'smelter-1',
            item: 'ore',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'link-2',
            playerId: 'player-a',
            sequence: 2,
            type: 'createLogisticsLink',
            sourceBuildingId: 'storage-1',
            targetBuildingId: 'smelter-1',
            item: 'ingot',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
  });
  it('rejects malformed, incomplete, and unsafe commands', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'command', command: { type: 'gather' } })),
    ).toBeUndefined();
    const invalidTransfer = {
      type: 'command',
      command: {
        id: 'x',
        playerId: 'p',
        sequence: 1,
        type: 'transfer',
        buildingId: 'b',
        item: 'ore',
        amount: -1,
        direction: 'toBuilding',
      },
    };
    expect(parseClientMessage(JSON.stringify(invalidTransfer))).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: { id: 'attack', playerId: 'p', sequence: 2, type: 'attack', target: 'player-b' },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'hello', version: 1, playerId: '../../database-admin' }),
      ),
    ).toBeUndefined();
  });

  it('accepts resynchronization requests only with a valid received version', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'resync', version: 12 }))).toEqual({
      type: 'resync',
      version: 12,
    });
    expect(parseClientMessage(JSON.stringify({ type: 'resync', version: -1 }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: 'resync', version: 1.5 }))).toBeUndefined();
  });

  it('accepts bounded integer chunk-interest updates only', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'interest', chunks: [{ x: -1, y: 2 }] })),
    ).toMatchObject({ type: 'interest', chunks: [{ x: -1, y: 2 }] });
    expect(
      parseClientMessage(JSON.stringify({ type: 'interest', chunks: [{ x: 0.5, y: 2 }] })),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'interest',
          chunks: Array.from({ length: 65 }, () => ({ x: 0, y: 0 })),
        }),
      ),
    ).toBeUndefined();
  });
});
