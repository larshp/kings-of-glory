import { describe, expect, it } from 'vitest';
import { buildingId as toBuildingId, isOpenTile, playerId as toPlayerId } from '@kings/simulation';
import { GlobalWorldHost, MemoryWorldPersistence, type Connection } from '../src/index.js';

/**
 * First buildable tile inside a player's plot. Terrain decides where a plot lands, so a
 * fixed coordinate would only work for the seeds whose ranges happen to miss it.
 */
const plotSite = (host: GlobalWorldHost, playerId: string) => {
  const plot = host.world.players[playerId]!.plot;
  for (let x = plot.x; x < plot.x + plot.size; x += 1)
    for (let y = plot.y; y < plot.y + plot.size; y += 1)
      if (isOpenTile(host.world.seed, x, y)) return { x, y };
  throw new Error(`Expected an open tile inside the plot of ${playerId}`);
};

const connection = (): Connection & { messages: string[] } => ({
  messages: [],
  send(message) {
    this.messages.push(message);
  },
  close() {},
});

const commandOutcome = (client: { messages: string[] }, commandId: string) =>
  client.messages
    .map(
      (message) =>
        JSON.parse(message) as {
          type: string;
          result?: { commandId: string; accepted: boolean; code?: string };
        },
    )
    .find(({ result }) => result?.commandId === commandId)?.result;

const commandOutcomes = (client: { messages: string[] }, commandId: string) =>
  client.messages
    .map(
      (message) =>
        JSON.parse(message) as {
          result?: { commandId: string; accepted: boolean; code?: string };
        },
    )
    .flatMap(({ result }) => (result?.commandId === commandId ? [result] : []));

class BlockingJournalPersistence extends MemoryWorldPersistence {
  #releaseFirst!: () => void;
  #firstGate = new Promise<void>((resolve) => {
    this.#releaseFirst = resolve;
  });
  #firstStarted!: () => void;
  readonly firstStarted = new Promise<void>((resolve) => {
    this.#firstStarted = resolve;
  });
  #blocked = false;

  override async appendAcceptedCommand(
    entry: Parameters<MemoryWorldPersistence['appendAcceptedCommand']>[0],
  ) {
    if (!this.#blocked) {
      this.#blocked = true;
      this.#firstStarted();
      await this.#firstGate;
    }
    return super.appendAcceptedCommand(entry);
  }

  releaseFirst() {
    this.#releaseFirst();
  }
}

describe('serialized world conflicts', () => {
  it('keeps many observers and writers consistent in one hot chunk', async () => {
    const host = new GlobalWorldHost();
    const clients = Array.from({ length: 20 }, () => connection());
    await Promise.all(clients.map((client, index) => host.connect(client, `hotspot-${index}`)));
    for (const client of clients) host.setInterest(client, [{ x: 0, y: 0 }]);
    host.world.players['hotspot-0']!.inventory = { ore: 0, wood: 0, ingot: 0, tool: 0 };

    await Promise.all(
      clients.slice(1).map((client, index) =>
        host.command(client, {
          id: `hotspot-transfer-${index + 1}`,
          playerId: toPlayerId(`hotspot-${index + 1}`),
          sequence: 1,
          type: 'transferToPlayer',
          targetPlayerId: toPlayerId('hotspot-0'),
          item: 'wood',
          amount: 1,
        }),
      ),
    );

    expect(host.world.players['hotspot-0']?.inventory.wood).toBe(19);
    expect(host.world.transfers).toHaveLength(19);
    expect(
      clients
        .slice(1)
        .every(
          (client, index) => commandOutcome(client, `hotspot-transfer-${index + 1}`)?.accepted,
        ),
    ).toBe(true);
    expect(
      clients.every((client) =>
        client.messages.some(
          (message) => (JSON.parse(message) as { type: string }).type === 'chunkSnapshot',
        ),
      ),
    ).toBe(true);
  });

  it('serializes overlapping transfers against recipient capacity and conserves inventory', async () => {
    const persistence = new BlockingJournalPersistence();
    const host = new GlobalWorldHost(1, persistence);
    const alice = connection();
    const bob = connection();
    const carol = connection();
    await host.connect(alice, 'player-a');
    await host.connect(bob, 'player-b');
    await host.connect(carol, 'player-c');
    host.world.players['player-a']!.inventory = { ore: 0, wood: 0, ingot: 5, tool: 0 };
    host.world.players['player-b']!.inventory = { ore: 0, wood: 0, ingot: 95, tool: 0 };
    host.world.players['player-c']!.inventory = { ore: 0, wood: 0, ingot: 5, tool: 0 };

    const first = host.command(alice, {
      id: 'overlap-transfer-a',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'transferToPlayer',
      targetPlayerId: toPlayerId('player-b'),
      item: 'ingot',
      amount: 5,
    });
    await persistence.firstStarted;
    const second = host.command(carol, {
      id: 'overlap-transfer-c',
      playerId: toPlayerId('player-c'),
      sequence: 1,
      type: 'transferToPlayer',
      targetPlayerId: toPlayerId('player-b'),
      item: 'ingot',
      amount: 5,
    });
    persistence.releaseFirst();
    await Promise.all([first, second]);

    expect(commandOutcome(alice, 'overlap-transfer-a')).toMatchObject({ accepted: true });
    expect(commandOutcome(carol, 'overlap-transfer-c')).toMatchObject({
      accepted: false,
      code: 'inventory-full',
    });
    expect(host.world.players['player-b']?.inventory.ingot).toBe(100);
    expect(
      Object.values(host.world.players).reduce(
        (total, player) => total + player.inventory.ingot,
        0,
      ),
    ).toBe(105);
    expect(host.world.transfers.map(({ id }) => id)).toEqual(['overlap-transfer-a']);
  });

  it('applies one copy of an overlapping duplicate transfer retry', async () => {
    const persistence = new BlockingJournalPersistence();
    const host = new GlobalWorldHost(1, persistence);
    const alice = connection();
    const bob = connection();
    await host.connect(alice, 'player-a');
    await host.connect(bob, 'player-b');
    const command = {
      id: 'overlap-duplicate-transfer',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'transferToPlayer' as const,
      targetPlayerId: toPlayerId('player-b'),
      item: 'wood' as const,
      amount: 2,
    };
    const first = host.command(alice, command);
    await persistence.firstStarted;
    const retry = host.command(alice, command);
    persistence.releaseFirst();
    await Promise.all([first, retry]);
    expect(commandOutcomes(alice, command.id)).toEqual([
      { accepted: true, commandId: command.id },
      { accepted: false, commandId: command.id, code: 'duplicate-command' },
    ]);
    expect(host.world.players['player-a']?.inventory.wood).toBe(3);
    expect(host.world.players['player-b']?.inventory.wood).toBe(7);
    expect(host.world.transfers).toHaveLength(1);
  });

  it('orders permission revocation against delegated building actions', async () => {
    const setup = async () => {
      const host = new GlobalWorldHost();
      const owner = connection();
      const builder = connection();
      await host.connect(owner, 'player-a');
      await host.connect(builder, 'player-b');
      await host.command(owner, {
        id: 'permission-smelter',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeSmelter',
        ...plotSite(host, 'player-a'),
      });
      await host.command(owner, {
        id: 'permission-invite',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'inviteToSettlement',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      });
      await host.command(builder, {
        id: 'permission-accept',
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'acceptSettlementInvite',
        settlementId: 'settlement-player-a',
      });
      await host.command(owner, {
        id: 'permission-delegate',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'setSettlementRole',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
        role: 'builder',
      });
      const smelter = Object.values(host.world.buildings).find(({ kind }) => kind === 'smelter')!;
      return { host, owner, builder, smelter };
    };

    const revokedFirst = await setup();
    await Promise.all([
      revokedFirst.host.command(revokedFirst.owner, {
        id: 'permission-revoke-first',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'removeSettlementMember',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }),
      revokedFirst.host.command(revokedFirst.builder, {
        id: 'permission-action-second',
        playerId: toPlayerId('player-b'),
        sequence: 2,
        type: 'setJobPriority',
        buildingId: revokedFirst.smelter.id,
        priority: 3,
      }),
    ]);
    expect(commandOutcome(revokedFirst.owner, 'permission-revoke-first')).toMatchObject({
      accepted: true,
    });
    expect(commandOutcome(revokedFirst.builder, 'permission-action-second')).toMatchObject({
      accepted: false,
      code: 'settlement-permission-denied',
    });
    expect(revokedFirst.smelter.jobPriority).toBe(1);

    const actionFirst = await setup();
    await Promise.all([
      actionFirst.host.command(actionFirst.builder, {
        id: 'permission-action-first',
        playerId: toPlayerId('player-b'),
        sequence: 2,
        type: 'setJobPriority',
        buildingId: actionFirst.smelter.id,
        priority: 3,
      }),
      actionFirst.host.command(actionFirst.owner, {
        id: 'permission-revoke-second',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'removeSettlementMember',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }),
    ]);
    expect(commandOutcome(actionFirst.builder, 'permission-action-first')).toMatchObject({
      accepted: true,
    });
    expect(commandOutcome(actionFirst.owner, 'permission-revoke-second')).toMatchObject({
      accepted: true,
    });
    expect(actionFirst.host.world.buildings[actionFirst.smelter.id]?.jobPriority).toBe(3);
    expect(
      actionFirst.host.world.settlements['settlement-player-a']?.members['player-b'],
    ).toBeUndefined();
  });

  it('orders invitation acceptance against removal without creating a ghost membership', async () => {
    const host = new GlobalWorldHost();
    const owner = connection();
    const invitee = connection();
    await host.connect(owner, 'player-a');
    await host.connect(invitee, 'player-b');
    await host.command(owner, {
      id: 'membership-invite',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    await Promise.all([
      host.command(invitee, {
        id: 'membership-accept',
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'acceptSettlementInvite',
        settlementId: 'settlement-player-a',
      }),
      host.command(owner, {
        id: 'membership-remove',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'removeSettlementMember',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }),
    ]);
    expect(commandOutcome(invitee, 'membership-accept')).toMatchObject({ accepted: true });
    expect(commandOutcome(owner, 'membership-remove')).toMatchObject({ accepted: true });
    expect(host.world.settlements['settlement-player-a']?.members['player-b']).toBeUndefined();
    expect(host.world.settlements['settlement-player-a']?.invitations['player-b']).toBeUndefined();
  });

  it('orders ownership transfer against member removal with exactly one valid owner', async () => {
    const host = new GlobalWorldHost();
    const owner = connection();
    const successor = connection();
    await host.connect(owner, 'player-a');
    await host.connect(successor, 'player-b');
    await host.command(owner, {
      id: 'ownership-invite',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    await host.command(successor, {
      id: 'ownership-accept',
      playerId: toPlayerId('player-b'),
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    await Promise.all([
      host.command(owner, {
        id: 'ownership-transfer',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'transferSettlementOwnership',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }),
      host.command(owner, {
        id: 'ownership-remove-after',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'removeSettlementMember',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }),
    ]);
    expect(commandOutcome(owner, 'ownership-transfer')).toMatchObject({ accepted: true });
    expect(commandOutcome(owner, 'ownership-remove-after')).toMatchObject({
      accepted: false,
      code: 'settlement-permission-denied',
    });
    const settlement = host.world.settlements['settlement-player-a']!;
    expect(settlement.ownerId).toBe('player-b');
    expect(Object.entries(settlement.members).filter(([, role]) => role === 'owner')).toEqual([
      ['player-b', 'owner'],
    ]);
  });
});
