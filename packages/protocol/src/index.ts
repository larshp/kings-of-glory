import type { Command, CommandResult, WorldState } from '@kings/simulation';

export type TerrainTile = 'grass' | 'water' | 'ore';
/** Network view: omits the global terrain seed so unexplored resources cannot be reconstructed. */
export interface ClientWorldState extends Omit<WorldState, 'seed'> {
  readonly terrain: Record<string, TerrainTile>;
}

/**
 * Every supplied field replaces that complete top-level state domain. This keeps
 * removals unambiguous while allowing quiet domains (such as terrain) to stay
 * off the wire between relevant-world changes.
 */
export type ClientWorldDelta = Partial<ClientWorldState>;

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type ClientMessage =
  | { type: 'hello'; version: number; playerId: string }
  | { type: 'command'; command: Command }
  | { type: 'resync'; version: number }
  | { type: 'ping'; nonce: string };

export type ServerMessage =
  | {
      type: 'welcome';
      version: number;
      playerId: string;
      stateVersion: number;
      state: ClientWorldState;
    }
  | {
      type: 'state';
      version: number;
      state?: ClientWorldState;
      baseVersion?: number;
      delta?: ClientWorldDelta;
    }
  | { type: 'commandResult'; result: CommandResult }
  | { type: 'pong'; nonce: string }
  | {
      type: 'error';
      code: 'bad-message' | 'version-mismatch' | 'message-too-large';
      message: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';
const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
const isCommand = (value: unknown): value is Command => {
  if (
    !isRecord(value) ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.playerId) ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.type !== 'string'
  )
    return false;
  if (
    value.type === 'gather' ||
    value.type === 'placeSmelter' ||
    value.type === 'placeStorage' ||
    value.type === 'placeHousing' ||
    value.type === 'placeWatchtower' ||
    value.type === 'explore' ||
    value.type === 'claimTerritory'
  )
    return Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y);
  if (value.type === 'research')
    return value.technologyId === 'metallurgy' || value.technologyId === 'territorial-charter';
  if (value.type === 'transferToPlayer')
    return (
      isIdentifier(value.targetPlayerId) &&
      (value.item === 'ore' || value.item === 'wood' || value.item === 'ingot') &&
      typeof value.amount === 'number' &&
      Number.isSafeInteger(value.amount) &&
      value.amount > 0
    );
  if (value.type === 'inviteToSettlement')
    return isIdentifier(value.settlementId) && isIdentifier(value.targetPlayerId);
  if (value.type === 'acceptSettlementInvite' || value.type === 'leaveSettlement')
    return isIdentifier(value.settlementId);
  if (value.type === 'setSettlementRole')
    return (
      isIdentifier(value.settlementId) &&
      isIdentifier(value.targetPlayerId) &&
      (value.role === 'member' || value.role === 'builder' || value.role === 'logistics')
    );
  if (value.type === 'transferSettlementOwnership')
    return isIdentifier(value.settlementId) && isIdentifier(value.targetPlayerId);
  if (value.type === 'createLogisticsLink')
    return (
      isIdentifier(value.sourceBuildingId) &&
      isIdentifier(value.targetBuildingId) &&
      value.item === 'ore'
    );
  if (value.type === 'removeLogisticsLink') return isIdentifier(value.linkId);
  if (value.type === 'setJobPriority')
    return (
      isIdentifier(value.buildingId) &&
      typeof value.priority === 'number' &&
      Number.isInteger(value.priority) &&
      value.priority >= 0 &&
      value.priority <= 3
    );
  if (
    value.type === 'smelt' ||
    value.type === 'repair' ||
    value.type === 'cancelConstruction' ||
    value.type === 'demolish'
  )
    return isIdentifier(value.buildingId);
  return (
    value.type === 'transfer' &&
    isIdentifier(value.buildingId) &&
    (value.item === 'ore' || value.item === 'wood' || value.item === 'ingot') &&
    typeof value.amount === 'number' &&
    Number.isSafeInteger(value.amount) &&
    value.amount > 0 &&
    (value.direction === 'toBuilding' || value.direction === 'toPlayer')
  );
};

export const parseClientMessage = (raw: string): ClientMessage | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const message = value as Record<string, unknown>;
    if (
      message.type === 'hello' &&
      typeof message.version === 'number' &&
      isIdentifier(message.playerId)
    )
      return message as ClientMessage;
    if (message.type === 'command' && isCommand(message.command)) return message as ClientMessage;
    if (
      message.type === 'resync' &&
      typeof message.version === 'number' &&
      Number.isSafeInteger(message.version) &&
      message.version >= 0
    )
      return message as ClientMessage;
    if (message.type === 'ping' && typeof message.nonce === 'string')
      return message as ClientMessage;
    return undefined;
  } catch {
    return undefined;
  }
};
