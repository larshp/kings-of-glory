import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  buildingId as toBuildingId,
  createWorld,
  inspectWorld,
  joinPlayer,
  playerId as toPlayerId,
} from '@kings/simulation';
import {
  applyAdministrativeMutation,
  GlobalWorldHost,
  inspectAdministrativeWorld,
  MemoryWorldPersistence,
  PostgresWorldPersistence,
  type AdministrativeAuditEvent,
  type CompletedCheckpoint,
} from '../src/index.js';

describe('administrative governance', () => {
  it('provides scoped player, settlement, transaction, moderation, and world inspection', () => {
    const world = createWorld(51);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    world.players['player-a']!.inventory.ore = 3;
    applyCommand(world, {
      id: 'admin-visible-transfer',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'transferToPlayer',
      targetPlayerId: toPlayerId('player-b'),
      item: 'ore',
      amount: 1,
    });
    expect(inspectAdministrativeWorld(world, { scope: 'world' })).toMatchObject({
      tick: 0,
      invariantErrors: [],
      counts: { players: 2, settlements: 2, transfers: 1 },
    });
    expect(inspectAdministrativeWorld(world, { scope: 'player', id: 'player-a' })).toMatchObject({
      player: { id: 'player-a', inventory: { ore: 2 } },
      displayName: 'Settler 1',
    });
    expect(
      inspectAdministrativeWorld(world, { scope: 'settlement', id: 'settlement-player-a' }),
    ).toMatchObject({ settlement: { ownerId: 'player-a' }, displayName: 'Settlement 1' });
    expect(inspectAdministrativeWorld(world, { scope: 'transactions' })).toMatchObject({
      transfers: [{ id: 'admin-visible-transfer' }],
    });
    expect(inspectAdministrativeWorld(world, { scope: 'moderation' })).toEqual({
      messages: [],
      reports: [],
    });
    expect(() => inspectAdministrativeWorld(world, { scope: 'player', id: 'missing' })).toThrow(
      'Unknown player',
    );
  });

  it('validates corrections and records exact inventory and ownership before/after state', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    applyCommand(world, {
      id: 'invite-admin-owner',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    applyCommand(world, {
      id: 'accept-admin-owner',
      playerId: toPlayerId('player-b'),
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    const inventory = applyAdministrativeMutation(world, {
      actorId: 'moderator@example.test',
      reason: '  Correcting   a verified support incident. ',
      mutation: { type: 'setPlayerInventory', playerId: 'player-a', item: 'ore', amount: 7 },
    });
    expect(world.players['player-a']?.inventory.ore).toBe(0);
    expect(inventory.state.players['player-a']?.inventory.ore).toBe(7);
    expect(inventory.audit).toMatchObject({
      actorId: 'moderator@example.test',
      reason: 'Correcting a verified support incident.',
      operation: 'setPlayerInventory',
      targetId: 'player-a',
      tick: 0,
      beforeState: { inventory: { ore: 0 } },
      afterState: { inventory: { ore: 7 } },
    });
    const ownership = applyAdministrativeMutation(inventory.state, {
      actorId: 'moderator@example.test',
      reason: 'Restoring governance after verified owner loss.',
      mutation: {
        type: 'setSettlementOwner',
        settlementId: 'settlement-player-a',
        playerId: 'player-b',
      },
    });
    expect(ownership.audit).toMatchObject({
      beforeState: {
        settlement: {
          ownerId: 'player-a',
          members: { 'player-a': 'owner', 'player-b': 'member' },
        },
      },
      afterState: {
        settlement: {
          ownerId: 'player-b',
          members: { 'player-a': 'member', 'player-b': 'owner' },
        },
      },
    });
    expect(inspectWorld(ownership.state)).toEqual([]);
    expect(() =>
      applyAdministrativeMutation(world, {
        actorId: 'x',
        reason: 'Too short',
        mutation: { type: 'setPlayerInventory', playerId: 'player-a', item: 'ore', amount: 1 },
      }),
    ).toThrow('actor');
    expect(() =>
      applyAdministrativeMutation(world, {
        actorId: 'moderator',
        reason: 'This correction would exceed inventory capacity.',
        mutation: { type: 'setPlayerInventory', playerId: 'player-a', item: 'ore', amount: 101 },
      }),
    ).toThrow('capacity');
  });

  it('removes retained messages and resolves reports without losing report evidence', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    applyCommand(world, {
      id: 'moderated-message',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'sendChatMessage',
      channel: 'global',
      text: 'Review me',
    });
    applyCommand(world, {
      id: 'moderation-report',
      playerId: toPlayerId('player-b'),
      sequence: 1,
      type: 'reportChatMessage',
      messageId: 'moderated-message',
      reason: 'Needs review',
    });
    const removed = applyAdministrativeMutation(world, {
      actorId: 'moderator',
      reason: 'Removing content after completed moderation review.',
      mutation: { type: 'removeChatMessage', messageId: 'moderated-message' },
    });
    expect(removed.state.social.messages).toEqual([]);
    expect(removed.state.social.reports[0]?.reportedMessage.id).toBe('moderated-message');
    expect(removed.audit.afterState).toBeNull();
    const resolved = applyAdministrativeMutation(removed.state, {
      actorId: 'moderator',
      reason: 'Closing the report after recording the final decision.',
      mutation: { type: 'resolveChatReport', reportId: 'moderation-report' },
    });
    expect(resolved.state.social.reports[0]?.status).toBe('resolved');
    expect(resolved.audit).toMatchObject({
      beforeState: { status: 'open' },
      afterState: { status: 'resolved' },
    });
    expect(inspectWorld(resolved.state)).toEqual([]);
  });

  it('commits a checkpoint and immutable audit before exposing an administrative mutation', async () => {
    const persistence = new MemoryWorldPersistence();
    const host = new GlobalWorldHost(1, persistence);
    const connection = { send() {}, close() {} };
    await host.connect(connection, 'player-a');
    const audit = await host.mutateAdministrative({
      actorId: 'support-agent',
      reason: 'Correcting inventory from a verified transaction failure.',
      mutation: { type: 'setPlayerInventory', playerId: 'player-a', item: 'ingot', amount: 4 },
    });
    expect(host.world.players['player-a']?.inventory.ingot).toBe(4);
    expect(persistence.administrativeAuditEvents()).toEqual([audit]);
    expect(await host.administrativeAuditEvents(1)).toEqual([audit]);
    expect(
      (await persistence.loadLatestCheckpoint())?.state.players['player-a']?.inventory.ingot,
    ).toBe(4);
  });

  it('does not expose a mutation when durable audit/checkpoint commit fails', async () => {
    class FailingAdministrativePersistence extends MemoryWorldPersistence {
      override async commitAdministrativeMutation(
        _state: Parameters<MemoryWorldPersistence['commitAdministrativeMutation']>[0],
        _audit: AdministrativeAuditEvent,
      ): Promise<CompletedCheckpoint> {
        throw new Error('audit storage unavailable');
      }
    }
    const persistence = new FailingAdministrativePersistence();
    const host = new GlobalWorldHost(1, persistence);
    const connection = { send() {}, close() {} };
    await host.connect(connection, 'player-a');
    await expect(
      host.mutateAdministrative({
        actorId: 'support-agent',
        reason: 'Attempting a correction while audit storage is unavailable.',
        mutation: { type: 'setPlayerInventory', playerId: 'player-a', item: 'ingot', amount: 4 },
      }),
    ).rejects.toThrow('audit storage unavailable');
    expect(host.world.players['player-a']?.inventory.ingot).toBe(0);
  });

  it('writes the PostgreSQL checkpoint and audit in one rollback-safe transaction', async () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const mutation = applyAdministrativeMutation(world, {
      actorId: 'support-agent',
      reason: 'Testing the durable administrative transaction boundary.',
      mutation: { type: 'setPlayerInventory', playerId: 'player-a', item: 'tool', amount: 2 },
    });
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql.startsWith('INSERT INTO administrative_audit_events'))
          throw new Error('audit insert failed');
        if (sql.includes('SELECT MIN(tick)')) return { rows: [{ oldest_tick: '0' }] };
        return { rows: [] };
      },
      release() {},
    };
    const persistence = new PostgresWorldPersistence({
      async connect() {
        return client;
      },
    } as never);
    await expect(
      persistence.commitAdministrativeMutation(mutation.state, mutation.audit),
    ).rejects.toThrow('audit insert failed');
    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain(
      'UPDATE world_checkpoints SET completed = true, completed_at = now() WHERE id = $1',
    );
    expect(
      statements.some((sql) => sql.startsWith('INSERT INTO administrative_audit_events')),
    ).toBe(true);
    expect(statements.at(-1)).toBe('ROLLBACK');
  });
});
