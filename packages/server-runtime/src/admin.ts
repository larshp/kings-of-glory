import { randomUUID } from 'node:crypto';
import {
  inspectWorld,
  PLAYER_INVENTORY_CAPACITY,
  playerId as toPlayerId,
  snapshot,
  stateHash,
  type Building,
  type Inventory,
  type ItemId,
  type WorldState,
} from '@kings/simulation';

export type AdministrativeInspectionRequest =
  | { readonly scope: 'world' }
  | { readonly scope: 'player'; readonly id: string }
  | { readonly scope: 'settlement'; readonly id: string }
  | { readonly scope: 'transactions' }
  | { readonly scope: 'moderation' };

export type AdministrativeMutation =
  | {
      readonly type: 'setPlayerInventory';
      readonly playerId: string;
      readonly item: ItemId;
      readonly amount: number;
    }
  | {
      readonly type: 'setSettlementOwner';
      readonly settlementId: string;
      readonly playerId: string;
    }
  | { readonly type: 'removeChatMessage'; readonly messageId: string }
  | { readonly type: 'resolveChatReport'; readonly reportId: string };

export interface AdministrativeMutationInput {
  readonly actorId: string;
  readonly reason: string;
  readonly mutation: AdministrativeMutation;
}

export interface AdministrativeAuditEvent {
  readonly id: string;
  readonly actorId: string;
  readonly reason: string;
  readonly operation: AdministrativeMutation['type'];
  readonly targetId: string;
  readonly beforeState: unknown;
  readonly afterState: unknown;
  readonly tick: number;
}

export interface AdministrativeMutationResult {
  readonly state: WorldState;
  readonly audit: AdministrativeAuditEvent;
}

const normalizedReason = (reason: string) => reason.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const clone = <T>(value: T): T => structuredClone(value);
const validActor = (actorId: string) => /^[A-Za-z0-9._@-]{3,64}$/.test(actorId);
const inventoryTotal = (inventory: Inventory) =>
  inventory.ore + inventory.wood + inventory.ingot + inventory.tool;
const auditTarget = (mutation: AdministrativeMutation) => {
  if (mutation.type === 'setPlayerInventory') return mutation.playerId;
  if (mutation.type === 'setSettlementOwner') return mutation.settlementId;
  if (mutation.type === 'removeChatMessage') return mutation.messageId;
  return mutation.reportId;
};

export const inspectAdministrativeWorld = (
  state: WorldState,
  request: AdministrativeInspectionRequest,
): unknown => {
  if (request.scope === 'world')
    return {
      schemaVersion: state.schemaVersion,
      tick: state.tick,
      peaceful: state.peaceful,
      stateHash: stateHash(state),
      invariantErrors: inspectWorld(state),
      counts: {
        players: Object.keys(state.players).length,
        deletedPlayers: Object.keys(state.deletedPlayers).length,
        settlements: Object.keys(state.settlements).length,
        buildings: Object.keys(state.buildings).length,
        threats: Object.keys(state.threats).length,
        transfers: state.transfers.length,
        chatMessages: state.social.messages.length,
        openReports: state.social.reports.filter(({ status }) => status === 'open').length,
      },
    };
  if (request.scope === 'player') {
    const player = state.players[request.id];
    const deleted = state.deletedPlayers[request.id];
    if (!player && !deleted) throw new Error(`Unknown player: ${request.id}`);
    if (deleted) return { deleted };
    return {
      player,
      displayName: state.social.playerNames[request.id],
      activity: state.playerActivity[request.id],
      settlements: Object.values(state.settlements)
        .filter(
          (settlement) => settlement.members[request.id] || settlement.invitations[request.id],
        )
        .map((settlement) => ({
          id: settlement.id,
          ownerId: settlement.ownerId,
          role: settlement.members[request.id],
          invited: Boolean(settlement.invitations[request.id]),
        })),
      ownedBuildingIds: Object.values(state.buildings)
        .filter(({ ownerId }) => ownerId === request.id)
        .map(({ id }) => id),
      transfers: state.transfers.filter(
        ({ fromPlayerId, toPlayerId }) => fromPlayerId === request.id || toPlayerId === request.id,
      ),
    };
  }
  if (request.scope === 'settlement') {
    const settlement = state.settlements[request.id];
    if (!settlement) throw new Error(`Unknown settlement: ${request.id}`);
    return {
      settlement,
      displayName: state.social.settlementNames[request.id],
      projects: Object.values(state.sharedConstructionProjects).filter(
        ({ settlementId }) => settlementId === request.id,
      ),
    };
  }
  if (request.scope === 'transactions')
    return {
      transfers: state.transfers,
      objectives: state.cooperativeObjectives,
      projectContributions: Object.values(state.sharedConstructionProjects).flatMap((project) =>
        project.contributionHistory.map((contribution) => ({
          projectId: project.id,
          settlementId: project.settlementId,
          ...contribution,
        })),
      ),
    };
  return { messages: state.social.messages, reports: state.social.reports };
};

export const applyAdministrativeMutation = (
  current: WorldState,
  input: AdministrativeMutationInput,
): AdministrativeMutationResult => {
  if (!validActor(input.actorId))
    throw new Error('Administrative actor must be 3-64 safe identifier characters');
  const reason = normalizedReason(input.reason);
  if ([...reason].length < 10 || [...reason].length > 500)
    throw new Error('Administrative reason must be 10-500 characters');
  const state = snapshot(current);
  let beforeState: unknown;
  let afterState: unknown;
  const mutation = input.mutation;

  if (mutation.type === 'setPlayerInventory') {
    const player = state.players[mutation.playerId];
    if (!player) throw new Error(`Unknown active player: ${mutation.playerId}`);
    if (!Number.isSafeInteger(mutation.amount) || mutation.amount < 0)
      throw new Error('Administrative inventory amount must be a non-negative safe integer');
    beforeState = { playerId: player.id, inventory: clone(player.inventory) };
    const inventory = { ...player.inventory, [mutation.item]: mutation.amount };
    if (inventoryTotal(inventory) > PLAYER_INVENTORY_CAPACITY)
      throw new Error(`Administrative inventory exceeds capacity ${PLAYER_INVENTORY_CAPACITY}`);
    player.inventory = inventory;
    afterState = { playerId: player.id, inventory: clone(player.inventory) };
  } else if (mutation.type === 'setSettlementOwner') {
    const settlement = state.settlements[mutation.settlementId];
    if (!settlement) throw new Error(`Unknown settlement: ${mutation.settlementId}`);
    if (!state.players[mutation.playerId])
      throw new Error(`Unknown active player: ${mutation.playerId}`);
    if (!settlement.members[mutation.playerId])
      throw new Error('Administrative owner must already be a settlement member');
    if (settlement.ownerId === mutation.playerId)
      throw new Error('Administrative owner is already the settlement owner');
    const projectBuildings = (): Record<string, Building> => {
      const buildings: Record<string, Building> = {};
      for (const project of Object.values(state.sharedConstructionProjects)) {
        if (project.settlementId !== settlement.id || !project.buildingId) continue;
        const building = state.buildings[project.buildingId];
        if (building) buildings[building.id] = building;
      }
      return buildings;
    };
    beforeState = { settlement: clone(settlement), projectBuildings: clone(projectBuildings()) };
    settlement.members[settlement.ownerId] = 'member';
    settlement.members[mutation.playerId] = 'owner';
    settlement.ownerId = toPlayerId(mutation.playerId);
    for (const building of Object.values(projectBuildings()))
      building.ownerId = toPlayerId(mutation.playerId);
    afterState = { settlement: clone(settlement), projectBuildings: clone(projectBuildings()) };
  } else if (mutation.type === 'removeChatMessage') {
    const index = state.social.messages.findIndex(({ id }) => id === mutation.messageId);
    if (index < 0) throw new Error(`Unknown retained chat message: ${mutation.messageId}`);
    beforeState = clone(state.social.messages[index]);
    state.social.messages.splice(index, 1);
    afterState = null;
  } else {
    const report = state.social.reports.find(({ id }) => id === mutation.reportId);
    if (!report) throw new Error(`Unknown chat report: ${mutation.reportId}`);
    if (report.status !== 'open') throw new Error(`Chat report is already ${report.status}`);
    beforeState = clone(report);
    report.status = 'resolved';
    afterState = clone(report);
  }

  const errors = inspectWorld(state);
  if (errors.length > 0)
    throw new Error(`Administrative mutation would invalidate the world: ${errors.join('; ')}`);
  return {
    state,
    audit: {
      id: randomUUID(),
      actorId: input.actorId,
      reason,
      operation: mutation.type,
      targetId: auditTarget(mutation),
      beforeState,
      afterState,
      tick: state.tick,
    },
  };
};
