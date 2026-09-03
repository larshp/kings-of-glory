import type { ClientWorldState, WorldMapChunkSummary } from '@kings/protocol';

/**
 * Prop types shared by the HUD tab panels. Each panel is its own component so a tab's
 * markup can be read without the rest of the HUD, and these are the handles they need
 * back into the connection and the world state that `App` owns.
 */

/** Queues a command for the server, optionally reporting the outcome to the player. */
export type SendCommand = (
  command: Record<string, unknown>,
  successMessage?: string,
  onAcknowledged?: () => void,
) => void;

/** The signed-in player's own record, which is absent until the world bootstrap arrives. */
export type PlayerView = ClientWorldState['players'][string];

export interface WorldMapView {
  chunks: WorldMapChunkSummary[];
  nextCursor?: string;
  totalExploredChunks: number;
}

/** A world tile the player has selected or is acting on. */
export interface Tile {
  readonly x: number;
  readonly y: number;
}

/** The carryable items; logistics and transfers are all expressed in them. */
export type { ItemKind } from '@kings/simulation';

/** Every panel renders as a tab panel that the tab strip shows or hides. */
export interface TabPanelProps {
  readonly hidden: boolean;
}
