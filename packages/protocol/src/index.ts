import { PLACEMENT_KINDS } from '@kings/simulation';
import type { Command, CommandResult, WorldState } from '@kings/simulation';

export type TerrainTile = 'grass' | 'water' | 'ore' | 'wood';
export interface ChunkInterest {
  readonly x: number;
  readonly y: number;
}
export interface WorldMapChunkSummary {
  readonly x: number;
  readonly y: number;
  readonly currentlyVisible: boolean;
  readonly terrain: Readonly<Record<TerrainTile, number>>;
  readonly ownBuildingCount: number;
  readonly visibleForeignBuildingCount: number;
  readonly visibleThreatCount: number;
  readonly claimedSectors: readonly { readonly ownerId: string; readonly count: number }[];
}
export interface WorldMapPage {
  readonly after?: string;
  readonly chunks: readonly WorldMapChunkSummary[];
  readonly nextCursor?: string;
  readonly totalExploredChunks: number;
}
export type DirectoryEntry =
  | { readonly type: 'player'; readonly playerId: string; readonly displayName: string }
  | {
      readonly type: 'settlement';
      readonly settlementId: string;
      readonly displayName: string;
      readonly ownerId: string;
      readonly memberCount: number;
    };
export interface DirectoryPage {
  readonly query: string;
  readonly after?: string;
  readonly entries: readonly DirectoryEntry[];
  readonly nextCursor?: string;
}
/** Network view: omits the global terrain seed so unexplored resources cannot be reconstructed. */
export interface ClientWorldState extends Omit<
  WorldState,
  'seed' | 'randomState' | 'deletedPlayers'
> {
  readonly terrain: Record<string, TerrainTile>;
  /** Public sector ownership, kept separate from private player state. */
  readonly territory: Record<string, string>;
}

/**
 * Every supplied field replaces that complete top-level state domain. This keeps
 * removals unambiguous while allowing quiet domains (such as terrain) to stay
 * off the wire between relevant-world changes.
 */
export type ClientWorldDelta = Partial<ClientWorldState>;

/** Bump whenever a client can no longer safely interpret server state messages. */
export const PROTOCOL_VERSION = 3;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_INTEREST_CHUNKS = 64;

export type ClientMessage =
  | { type: 'hello'; version: number; playerId: string }
  | { type: 'command'; command: Command }
  | { type: 'interest'; chunks: readonly ChunkInterest[] }
  | { type: 'worldMap'; requestId: string; after?: string; limit: number }
  | { type: 'directorySearch'; requestId: string; query: string; after?: string; limit: number }
  | { type: 'resync'; version: number }
  | { type: 'ping'; nonce: string };

export type ServerMessage =
  /** Handshake and development authentication acknowledgement. */
  | {
      type: 'welcome';
      version: number;
      playerId: string;
    }
  /** Complete, filtered state used after authentication and full resynchronization. */
  | {
      type: 'worldBootstrap';
      playerId: string;
      stateVersion: number;
      state: ClientWorldState;
    }
  /** Full filtered state sent when a viewport subscribes to newly relevant chunks. */
  | {
      type: 'chunkSnapshot';
      version: number;
      state: ClientWorldState;
      chunks: readonly ChunkInterest[];
    }
  /** Versioned replacement domains following a known prior state version. */
  | {
      type: 'stateDelta';
      version: number;
      baseVersion?: number;
      delta: ClientWorldDelta;
    }
  | { type: 'commandAcknowledged'; result: Extract<CommandResult, { accepted: true }> }
  | { type: 'commandRejected'; result: Extract<CommandResult, { accepted: false }> }
  | { type: 'pong'; nonce: string }
  | { type: 'worldMapPage'; requestId: string; page: WorldMapPage }
  | { type: 'directoryPage'; requestId: string; page: DirectoryPage }
  | { type: 'maintenance'; message: string }
  | {
      type: 'error';
      code: 'bad-message' | 'version-mismatch' | 'message-too-large' | 'server-busy';
      message: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';
const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
const isItem = (value: unknown): value is 'ore' | 'wood' | 'ingot' | 'tool' =>
  value === 'ore' || value === 'wood' || value === 'ingot' || value === 'tool';
const sharedBuildingKinds: readonly string[] = Object.values(PLACEMENT_KINDS);
const isSharedBuildingKind = (value: unknown) =>
  typeof value === 'string' && sharedBuildingKinds.includes(value);
const isBoundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length <= maxLength;
const isChunkInterest = (value: unknown): value is readonly ChunkInterest[] =>
  Array.isArray(value) &&
  value.length <= MAX_INTEREST_CHUNKS &&
  value.every(
    (chunk) => isRecord(chunk) && Number.isSafeInteger(chunk.x) && Number.isSafeInteger(chunk.y),
  );
const isChunkCursor = (value: unknown): value is string =>
  typeof value === 'string' && /^-?\d+:-?\d+$/.test(value) && value.length <= 32;
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
    value.type === 'explore' ||
    value.type === 'claimTerritory' ||
    value.type in PLACEMENT_KINDS
  )
    return Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y);
  if (value.type === 'moveScout')
    return (
      isIdentifier(value.scoutId) && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y)
    );
  if (value.type === 'research')
    return value.technologyId === 'metallurgy' || value.technologyId === 'territorial-charter';
  if (value.type === 'contributeToObjective')
    return (
      value.objectiveId === 'frontier-beacon' &&
      isIdentifier(value.settlementId) &&
      typeof value.amount === 'number' &&
      Number.isSafeInteger(value.amount) &&
      value.amount > 0
    );
  if (value.type === 'claimObjectiveReward') return value.objectiveId === 'frontier-beacon';
  if (value.type === 'setPlayerName') return isBoundedText(value.name, 64);
  if (value.type === 'setSettlementName')
    return isIdentifier(value.settlementId) && isBoundedText(value.name, 64);
  if (value.type === 'sendChatMessage')
    return (
      isBoundedText(value.text, 1_024) &&
      (value.channel === 'global' ||
        (value.channel === 'settlement' && isIdentifier(value.settlementId)))
    );
  if (value.type === 'setPlayerBlocked')
    return isIdentifier(value.targetPlayerId) && typeof value.blocked === 'boolean';
  if (value.type === 'reportChatMessage')
    return isIdentifier(value.messageId) && isBoundedText(value.reason, 400);
  if (value.type === 'deleteAccount') return isBoundedText(value.confirmation, 16);
  if (value.type === 'createSharedConstructionProject')
    return (
      isIdentifier(value.settlementId) &&
      isSharedBuildingKind(value.buildingKind) &&
      Number.isSafeInteger(value.x) &&
      Number.isSafeInteger(value.y)
    );
  if (value.type === 'contributeToSharedConstructionProject')
    return (
      isIdentifier(value.projectId) &&
      isItem(value.item) &&
      typeof value.amount === 'number' &&
      Number.isSafeInteger(value.amount) &&
      value.amount > 0
    );
  if (value.type === 'transferToPlayer')
    return (
      isIdentifier(value.targetPlayerId) &&
      isItem(value.item) &&
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
  if (value.type === 'transferSettlementOwnership' || value.type === 'removeSettlementMember')
    return isIdentifier(value.settlementId) && isIdentifier(value.targetPlayerId);
  if (value.type === 'createLogisticsLink')
    return (
      isIdentifier(value.sourceBuildingId) &&
      isIdentifier(value.targetBuildingId) &&
      isItem(value.item)
    );
  if (value.type === 'removeLogisticsLink') return isIdentifier(value.linkId);
  if (value.type === 'setLogisticsPriority')
    return (
      isIdentifier(value.linkId) &&
      typeof value.priority === 'number' &&
      Number.isInteger(value.priority) &&
      value.priority >= 0 &&
      value.priority <= 3
    );
  if (value.type === 'setJobPriority')
    return (
      isIdentifier(value.buildingId) &&
      typeof value.priority === 'number' &&
      Number.isInteger(value.priority) &&
      value.priority >= 0 &&
      value.priority <= 3
    );
  if (value.type === 'setRecipe')
    return isIdentifier(value.buildingId) && isIdentifier(value.recipeId);
  if (value.type === 'copyBuildingConfiguration')
    return isIdentifier(value.sourceBuildingId) && isIdentifier(value.targetBuildingId);
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
    isItem(value.item) &&
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
      Number.isSafeInteger(message.version) &&
      message.version >= 0 &&
      isIdentifier(message.playerId)
    )
      return message as ClientMessage;
    if (message.type === 'command' && isCommand(message.command)) return message as ClientMessage;
    if (message.type === 'interest' && isChunkInterest(message.chunks))
      return message as ClientMessage;
    if (
      message.type === 'worldMap' &&
      isIdentifier(message.requestId) &&
      (message.after === undefined || isChunkCursor(message.after)) &&
      Number.isSafeInteger(message.limit) &&
      typeof message.limit === 'number' &&
      message.limit >= 1 &&
      message.limit <= 256
    )
      return message as ClientMessage;
    if (
      message.type === 'directorySearch' &&
      isIdentifier(message.requestId) &&
      typeof message.query === 'string' &&
      message.query.length <= 32 &&
      (message.after === undefined ||
        (typeof message.after === 'string' &&
          /^(player|settlement):[A-Za-z0-9._-]{1,64}$/.test(message.after))) &&
      Number.isSafeInteger(message.limit) &&
      typeof message.limit === 'number' &&
      message.limit >= 1 &&
      message.limit <= 50
    )
      return message as ClientMessage;
    if (
      message.type === 'resync' &&
      typeof message.version === 'number' &&
      Number.isSafeInteger(message.version) &&
      message.version >= 0
    )
      return message as ClientMessage;
    if (message.type === 'ping' && isIdentifier(message.nonce)) return message as ClientMessage;
    return undefined;
  } catch {
    return undefined;
  }
};
