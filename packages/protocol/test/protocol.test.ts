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
  it('accepts only a bounded account-deletion confirmation', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'delete-account-1',
            playerId: 'player-a',
            sequence: 1,
            type: 'deleteAccount',
            confirmation: 'DELETE',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'delete-account-2',
            playerId: 'player-a',
            sequence: 2,
            type: 'deleteAccount',
            confirmation: 'x'.repeat(17),
          },
        }),
      ),
    ).toBeUndefined();
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
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'priority-1',
            playerId: 'player-a',
            sequence: 3,
            type: 'setLogisticsPriority',
            linkId: 'link-storage-smelter-ore',
            priority: 3,
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'priority-invalid',
            playerId: 'player-a',
            sequence: 4,
            type: 'setLogisticsPriority',
            linkId: 'link-storage-smelter-ore',
            priority: 4,
          },
        }),
      ),
    ).toBeUndefined();
  });
  it('accepts only a safe producer recipe configuration command', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'recipe-1',
            playerId: 'player-a',
            sequence: 1,
            type: 'setRecipe',
            buildingId: 'workshop-1',
            recipeId: 'forge-tool-without-wood',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'recipe-2',
            playerId: 'player-a',
            sequence: 2,
            type: 'setRecipe',
            buildingId: 'workshop-1',
            recipeId: '../../smelt-ore',
          },
        }),
      ),
    ).toBeUndefined();
  });
  it('accepts only safe source and target identifiers for configuration copying', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'copy-1',
            playerId: 'player-a',
            sequence: 1,
            type: 'copyBuildingConfiguration',
            sourceBuildingId: 'workshop-a',
            targetBuildingId: 'workshop-b',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'copy-2',
            playerId: 'player-a',
            sequence: 2,
            type: 'copyBuildingConfiguration',
            sourceBuildingId: 'workshop-a',
            targetBuildingId: '../../checkpoint',
          },
        }),
      ),
    ).toBeUndefined();
  });
  it('accepts only bounded cooperative objective commands', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'contribute-1',
            playerId: 'player-a',
            sequence: 1,
            type: 'contributeToObjective',
            objectiveId: 'frontier-beacon',
            settlementId: 'settlement-player-a',
            amount: 2,
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'contribute-invalid',
            playerId: 'player-a',
            sequence: 2,
            type: 'contributeToObjective',
            objectiveId: 'frontier-beacon',
            settlementId: 'settlement-player-a',
            amount: 0,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'claim-1',
            playerId: 'player-a',
            sequence: 3,
            type: 'claimObjectiveReward',
            objectiveId: 'frontier-beacon',
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
  });
  it('accepts only bounded shared-construction project commands', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'project-1',
            playerId: 'player-a',
            sequence: 1,
            type: 'createSharedConstructionProject',
            settlementId: 'settlement-player-a',
            buildingKind: 'storage',
            x: 12,
            y: 1,
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'project-invalid',
            playerId: 'player-a',
            sequence: 2,
            type: 'createSharedConstructionProject',
            settlementId: 'settlement-player-a',
            buildingKind: 'settlement-center',
            x: 12,
            y: 1,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'fund-1',
            playerId: 'player-b',
            sequence: 1,
            type: 'contributeToSharedConstructionProject',
            projectId: 'project-1',
            item: 'wood',
            amount: 1,
          },
        }),
      ),
    ).toMatchObject({ type: 'command' });
  });
  it('accepts bounded social commands and rejects oversized or malformed text', () => {
    for (const command of [
      { type: 'setPlayerName', name: 'River Warden' },
      {
        type: 'setSettlementName',
        settlementId: 'settlement-player-a',
        name: 'Iron Vale',
      },
      { type: 'sendChatMessage', channel: 'global', text: 'Need wood.' },
      {
        type: 'sendChatMessage',
        channel: 'settlement',
        settlementId: 'settlement-player-a',
        text: 'Storage is ready.',
      },
      { type: 'setPlayerBlocked', targetPlayerId: 'player-b', blocked: true },
      { type: 'reportChatMessage', messageId: 'message-1', reason: 'Abusive message' },
    ])
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'command',
            command: {
              id: `social-${command.type}`,
              playerId: 'player-a',
              sequence: 1,
              ...command,
            },
          }),
        ),
      ).toMatchObject({ type: 'command' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'oversized-chat',
            playerId: 'player-a',
            sequence: 1,
            type: 'sendChatMessage',
            channel: 'global',
            text: 'x'.repeat(1_025),
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'command',
          command: {
            id: 'malformed-block',
            playerId: 'player-a',
            sequence: 1,
            type: 'setPlayerBlocked',
            targetPlayerId: '../../player',
            blocked: 'yes',
          },
        }),
      ),
    ).toBeUndefined();
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
    expect(
      parseClientMessage(JSON.stringify({ type: 'hello', version: 1.5, playerId: 'player-a' })),
    ).toBeUndefined();
    expect(
      parseClientMessage(JSON.stringify({ type: 'ping', nonce: 'x'.repeat(65) })),
    ).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: 'ping', nonce: '../admin' }))).toBeUndefined();
  });

  it('accepts resynchronization requests only with a valid received version', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'resync', version: 12 }))).toEqual({
      type: 'resync',
      version: 12,
    });
    expect(parseClientMessage(JSON.stringify({ type: 'resync', version: -1 }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: 'resync', version: 1.5 }))).toBeUndefined();
  });

  it('accepts bounded directory searches and rejects unsafe cursors', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'directorySearch',
          requestId: 'directory-1',
          query: 'player',
          limit: 20,
        }),
      ),
    ).toMatchObject({ type: 'directorySearch' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'directorySearch',
          requestId: 'directory-2',
          query: '',
          after: 'player:player-a',
          limit: 50,
        }),
      ),
    ).toMatchObject({ type: 'directorySearch' });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'directorySearch',
          requestId: 'directory-3',
          query: 'x'.repeat(33),
          after: '../../players',
          limit: 51,
        }),
      ),
    ).toBeUndefined();
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

  it('accepts bounded paginated strategic-map requests only', () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'worldMap', requestId: 'map-1', after: '-2:3', limit: 64 }),
      ),
    ).toEqual({ type: 'worldMap', requestId: 'map-1', after: '-2:3', limit: 64 });
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'worldMap', requestId: 'map-2', after: 'hidden', limit: 64 }),
      ),
    ).toBeUndefined();
    expect(
      parseClientMessage(JSON.stringify({ type: 'worldMap', requestId: 'map-3', limit: 257 })),
    ).toBeUndefined();
  });
});
