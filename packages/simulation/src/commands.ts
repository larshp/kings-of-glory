export type PlayerId = string & { readonly __brand: 'PlayerId' };
export type BuildingId = string & { readonly __brand: 'BuildingId' };
export type WorldId = string & { readonly __brand: 'WorldId' };
export type Tick = number & { readonly __brand: 'Tick' };
export type ChunkCoordinate = readonly [number, number] & { readonly __brand: 'ChunkCoordinate' };
export type TileCoordinate = readonly [number, number] & { readonly __brand: 'TileCoordinate' };
export type SettlementRole = 'owner' | 'builder' | 'logistics' | 'member';

export const playerId = (value: string): PlayerId => value as PlayerId;
export const buildingId = (value: string): BuildingId => value as BuildingId;
export const worldId = (value: string): WorldId => value as WorldId;
export const tick = (value: number): Tick => value as Tick;

const coordinate = <T extends ChunkCoordinate | TileCoordinate>(
  x: number,
  y: number,
  label: string,
): T => {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y))
    throw new Error(`${label} coordinates must be safe integers.`);
  return [x, y] as unknown as T;
};

export const chunkCoordinate = (x: number, y: number): ChunkCoordinate =>
  coordinate<ChunkCoordinate>(x, y, 'Chunk');
export const tileCoordinate = (x: number, y: number): TileCoordinate =>
  coordinate<TileCoordinate>(x, y, 'Tile');

export type Command =
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'gather';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'placeSmelter';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'placeWorkshop';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'placeStorage';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'placeHousing';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'placeHearth';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'placeWatchtower';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'explore';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'moveScout';
      readonly scoutId: string;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'claimTerritory';
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'research';
      readonly technologyId: 'metallurgy' | 'territorial-charter';
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'smelt';
      readonly buildingId: BuildingId;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'transfer';
      readonly buildingId: BuildingId;
      readonly item: 'ore' | 'wood' | 'ingot' | 'tool';
      readonly amount: number;
      readonly direction: 'toBuilding' | 'toPlayer';
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'transferToPlayer';
      readonly targetPlayerId: PlayerId;
      readonly item: 'ore' | 'wood' | 'ingot' | 'tool';
      readonly amount: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'inviteToSettlement';
      readonly settlementId: string;
      readonly targetPlayerId: PlayerId;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'acceptSettlementInvite';
      readonly settlementId: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'setSettlementRole';
      readonly settlementId: string;
      readonly targetPlayerId: PlayerId;
      readonly role: Exclude<SettlementRole, 'owner'>;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'transferSettlementOwnership';
      readonly settlementId: string;
      readonly targetPlayerId: PlayerId;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'leaveSettlement';
      readonly settlementId: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'removeSettlementMember';
      readonly settlementId: string;
      readonly targetPlayerId: PlayerId;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'createLogisticsLink';
      readonly sourceBuildingId: BuildingId;
      readonly targetBuildingId: BuildingId;
      readonly item: 'ore' | 'wood' | 'ingot' | 'tool';
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'removeLogisticsLink';
      readonly linkId: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'setLogisticsPriority';
      readonly linkId: string;
      readonly priority: 0 | 1 | 2 | 3;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'setJobPriority';
      readonly buildingId: BuildingId;
      readonly priority: 0 | 1 | 2 | 3;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'setRecipe';
      readonly buildingId: BuildingId;
      readonly recipeId: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'copyBuildingConfiguration';
      readonly sourceBuildingId: BuildingId;
      readonly targetBuildingId: BuildingId;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'repair';
      readonly buildingId: BuildingId;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'cancelConstruction';
      readonly buildingId: BuildingId;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'demolish';
      readonly buildingId: BuildingId;
    };

export type RejectionCode =
  | 'unknown-player'
  | 'unauthorized'
  | 'invalid-coordinate'
  | 'duplicate-command'
  | 'out-of-order-command'
  | 'out-of-range'
  | 'outside-plot'
  | 'occupied'
  | 'insufficient-wood'
  | 'insufficient-ore'
  | 'insufficient-resources'
  | 'unknown-building'
  | 'unknown-scout'
  | 'not-owner'
  | 'building-destroyed'
  | 'persistence-failed'
  | 'resource-depleted'
  | 'tile-not-buildable'
  | 'inventory-full'
  | 'construction-incomplete'
  | 'busy'
  | 'wrong-building'
  | 'invalid-recipe'
  | 'incompatible-building'
  | 'cannot-demolish'
  | 'invalid-amount'
  | 'not-explored'
  | 'not-adjacent'
  | 'territory-claimed'
  | 'technology-locked'
  | 'research-in-progress'
  | 'already-researched'
  | 'unknown-recipient'
  | 'unknown-settlement'
  | 'settlement-permission-denied'
  | 'settlement-invite-missing'
  | 'not-settlement-member'
  | 'already-settlement-member'
  | 'cannot-leave-settlement-owner'
  | 'cannot-remove-settlement-owner'
  | 'cannot-transfer-settlement-ownership-to-self'
  | 'invalid-logistics-link'
  | 'logistics-link-exists'
  | 'unknown-logistics-link';

export type CommandResult =
  | { readonly accepted: true; readonly commandId: string }
  | { readonly accepted: false; readonly commandId: string; readonly code: RejectionCode };
