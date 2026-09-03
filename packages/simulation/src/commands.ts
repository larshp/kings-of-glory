export type PlayerId = string & { readonly __brand: 'PlayerId' };
export type BuildingId = string & { readonly __brand: 'BuildingId' };
export type WorldId = string & { readonly __brand: 'WorldId' };
export type Tick = number & { readonly __brand: 'Tick' };
export type ChunkCoordinate = readonly [number, number] & { readonly __brand: 'ChunkCoordinate' };
export type TileCoordinate = readonly [number, number] & { readonly __brand: 'TileCoordinate' };
export type SettlementRole = 'owner' | 'builder' | 'logistics' | 'member';
export type SharedProjectBuildingKind =
  | 'smelter'
  | 'workshop'
  | 'storage'
  | 'housing'
  | 'hearth'
  | 'watchtower'
  | 'mine'
  | 'lumber-camp'
  | 'forester'
  | 'quarry'
  | 'brickworks'
  | 'wall'
  | 'foundry'
  | 'bastion'
  | 'guild-hall';

/** Every item a command can name. Inventories, links, and transfers all speak this set. */
export type ItemKind = 'ore' | 'wood' | 'stone' | 'ingot' | 'brick' | 'tool' | 'steel';

/** Maps every placement command onto the building kind it creates. */
export const PLACEMENT_KINDS = {
  placeSmelter: 'smelter',
  placeWorkshop: 'workshop',
  placeStorage: 'storage',
  placeHousing: 'housing',
  placeHearth: 'hearth',
  placeWatchtower: 'watchtower',
  placeMine: 'mine',
  placeLumberCamp: 'lumber-camp',
  placeForester: 'forester',
  placeQuarry: 'quarry',
  placeBrickworks: 'brickworks',
  placeWall: 'wall',
  placeFoundry: 'foundry',
  placeBastion: 'bastion',
  placeGuildHall: 'guild-hall',
} as const satisfies Readonly<Record<string, SharedProjectBuildingKind>>;
export type PlacementCommandType = keyof typeof PLACEMENT_KINDS;

/**
 * One placement command per building kind, derived from `PLACEMENT_KINDS` so a new
 * building needs a single entry there rather than another hand-written variant.
 */
export type PlacementCommand = {
  readonly [Type in PlacementCommandType]: {
    readonly id: string;
    readonly playerId: PlayerId;
    readonly sequence: number;
    readonly type: Type;
    readonly x: number;
    readonly y: number;
  };
}[PlacementCommandType];

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
  | PlacementCommand
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'gather';
      readonly x: number;
      readonly y: number;
      /** One item is gathered immediately; the remainder becomes a worker-backed order. */
      readonly amount?: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'cancelGatherOrder';
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'placeRoad';
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
      readonly technologyId:
        'metallurgy' | 'territorial-charter' | 'engineering' | 'stewardship' | 'masonry';
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
      readonly item: ItemKind;
      readonly amount: number;
      readonly direction: 'toBuilding' | 'toPlayer';
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'transferToPlayer';
      readonly targetPlayerId: PlayerId;
      readonly item: ItemKind;
      readonly amount: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'setPlayerName';
      readonly name: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'setSettlementName';
      readonly settlementId: string;
      readonly name: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'sendChatMessage';
      readonly channel: 'global';
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'sendChatMessage';
      readonly channel: 'settlement';
      readonly settlementId: string;
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'setPlayerBlocked';
      readonly targetPlayerId: PlayerId;
      readonly blocked: boolean;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'reportChatMessage';
      readonly messageId: string;
      readonly reason: string;
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
      readonly type: 'deleteAccount';
      readonly confirmation: string;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'createLogisticsLink';
      readonly sourceBuildingId: BuildingId;
      readonly targetBuildingId: BuildingId;
      readonly item: ItemKind;
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
      readonly type: 'setLogisticsStockTarget';
      readonly linkId: string;
      readonly minimum: number;
      readonly maximum: number;
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
      readonly type: 'contributeToObjective';
      readonly objectiveId: 'frontier-beacon';
      readonly settlementId: string;
      readonly amount: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'claimObjectiveReward';
      readonly objectiveId: 'frontier-beacon';
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'createSharedConstructionProject';
      readonly settlementId: string;
      readonly buildingKind: SharedProjectBuildingKind;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'contributeToSharedConstructionProject';
      readonly projectId: string;
      readonly item: ItemKind;
      readonly amount: number;
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
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'upgradeBuilding';
      readonly buildingId: BuildingId;
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'resolveLandmark';
      readonly x: number;
      readonly y: number;
      readonly choice: 'salvage' | 'develop';
    }
  | {
      readonly id: string;
      readonly playerId: PlayerId;
      readonly sequence: number;
      readonly type: 'startSettlementInitiative';
      readonly initiativeId: 'freight-charter' | 'builders-festival';
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
  | 'upgrade-unavailable'
  | 'already-upgraded'
  | 'insufficient-resources'
  | 'unknown-building'
  | 'unknown-scout'
  | 'not-owner'
  | 'building-destroyed'
  | 'persistence-failed'
  | 'resource-depleted'
  | 'no-deposit-in-range'
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
  | 'protected-area'
  | 'reserved-resource'
  | 'technology-locked'
  | 'research-in-progress'
  | 'already-researched'
  | 'research-branch-locked'
  | 'road-exists'
  | 'unknown-recipient'
  | 'unknown-settlement'
  | 'settlement-permission-denied'
  | 'settlement-invite-missing'
  | 'not-settlement-member'
  | 'already-settlement-member'
  | 'cannot-leave-settlement-owner'
  | 'cannot-remove-settlement-owner'
  | 'cannot-transfer-settlement-ownership-to-self'
  | 'cannot-delete-settlement-owner'
  | 'account-deletion-confirmation-required'
  | 'account-deleted'
  | 'invalid-logistics-link'
  | 'logistics-link-exists'
  | 'unknown-logistics-link'
  | 'unknown-objective'
  | 'objective-inactive'
  | 'objective-complete'
  | 'objective-incomplete'
  | 'objective-contribution-required'
  | 'reward-already-claimed'
  | 'unknown-project'
  | 'project-complete'
  | 'project-limit-reached'
  | 'construction-limit-reached'
  | 'invalid-name'
  | 'name-taken'
  | 'content-rejected'
  | 'chat-rate-limited'
  | 'invalid-message'
  | 'unknown-message'
  | 'already-reported'
  | 'cannot-block-self'
  | 'unknown-landmark'
  | 'landmark-already-resolved'
  | 'initiative-active';

export type CommandResult =
  | { readonly accepted: true; readonly commandId: string }
  | { readonly accepted: false; readonly commandId: string; readonly code: RejectionCode };
