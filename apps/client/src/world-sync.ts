import type { ClientWorldState, ServerMessage } from '@kings/protocol';

export interface WorldSyncState {
  readonly version: number | undefined;
  readonly state: ClientWorldState | undefined;
}

export interface WorldSyncResult {
  readonly sync: WorldSyncState;
  /** The caller must request a complete resync before accepting further deltas. */
  readonly needsResync: boolean;
}

const unchanged = (sync: WorldSyncState): WorldSyncResult => ({ sync, needsResync: false });

/**
 * Applies only contiguous server state. A stale response is harmlessly ignored;
 * a gap (including a reordered response) asks the authoritative server for a
 * replacement bootstrap instead of guessing how to merge state.
 */
export const synchronizeWorld = (
  current: WorldSyncState,
  message: ServerMessage,
): WorldSyncResult => {
  if (message.type === 'worldBootstrap' || message.type === 'chunkSnapshot') {
    const version = message.type === 'worldBootstrap' ? message.stateVersion : message.version;
    if (current.version !== undefined && version < current.version) return unchanged(current);
    return { sync: { version, state: message.state }, needsResync: false };
  }
  if (message.type !== 'stateDelta') return unchanged(current);
  if (current.version === undefined || !current.state) return { sync: current, needsResync: true };
  if (message.version <= current.version) return unchanged(current);
  if (message.baseVersion !== current.version) return { sync: current, needsResync: true };
  return {
    sync: { version: message.version, state: { ...current.state, ...message.delta } },
    needsResync: false,
  };
};
