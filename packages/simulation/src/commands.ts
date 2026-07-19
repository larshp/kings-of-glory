export type PlayerId = string & { readonly __brand: 'PlayerId' };
export type BuildingId = string & { readonly __brand: 'BuildingId' };
export type Tick = number & { readonly __brand: 'Tick' };

export const playerId = (value: string): PlayerId => value as PlayerId;
export const buildingId = (value: string): BuildingId => value as BuildingId;

export type Command =
  | { readonly id: string; readonly playerId: PlayerId; readonly sequence: number; readonly type: 'gather'; readonly x: number; readonly y: number }
  | { readonly id: string; readonly playerId: PlayerId; readonly sequence: number; readonly type: 'placeSmelter'; readonly x: number; readonly y: number }
  | { readonly id: string; readonly playerId: PlayerId; readonly sequence: number; readonly type: 'smelt'; readonly buildingId: BuildingId }
  | { readonly id: string; readonly playerId: PlayerId; readonly sequence: number; readonly type: 'repair'; readonly buildingId: BuildingId }
  | { readonly id: string; readonly playerId: PlayerId; readonly sequence: number; readonly type: 'cancelConstruction'; readonly buildingId: BuildingId }
  | { readonly id: string; readonly playerId: PlayerId; readonly sequence: number; readonly type: 'demolish'; readonly buildingId: BuildingId };

export type RejectionCode =
  | 'unknown-player'
  | 'duplicate-command'
  | 'out-of-order-command'
  | 'out-of-range'
  | 'outside-plot'
  | 'occupied'
  | 'insufficient-wood'
  | 'insufficient-ore'
  | 'unknown-building'
  | 'not-owner'
  | 'building-destroyed'
  | 'persistence-failed'
  | 'resource-depleted'
  | 'tile-not-buildable'
  | 'inventory-full'
  | 'construction-incomplete'
  | 'busy'
  | 'wrong-building'
  | 'cannot-demolish';

export type CommandResult =
  | { readonly accepted: true; readonly commandId: string }
  | { readonly accepted: false; readonly commandId: string; readonly code: RejectionCode };
