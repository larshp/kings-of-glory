import type { PlayerView, SendCommand, TabPanelProps, Tile, WorldMapView } from './types.js';

export interface WorldPanelProps extends TabPanelProps {
  readonly player: PlayerView | undefined;
  readonly activeThreats: readonly { readonly id: string }[];
  /** The tile both frontier actions target: whatever the player selected on the map. */
  readonly selectedTile: Tile | undefined;
  readonly selectedSector:
    | {
        readonly explored: boolean;
        readonly claimedBy: 'you' | 'other' | undefined;
        readonly adjacentToOwnClaim: boolean;
      }
    | undefined;
  readonly worldMap: WorldMapView | undefined;
  readonly worldMapLoading: boolean;
  readonly requestWorldMap: (after?: string) => void;
  readonly send: SendCommand;
}

/**
 * Defense summary, frontier actions on the selected sector, and the strategic map. The
 * frontier actions deliberately have no invisible default target: a button that explores or
 * claims somewhere the player cannot see gives them no way to judge the outcome.
 */
export const WorldPanel = ({
  hidden,
  player,
  activeThreats,
  selectedTile,
  selectedSector,
  worldMap,
  worldMapLoading,
  requestWorldMap,
  send,
}: WorldPanelProps) => (
  <div
    aria-labelledby="hud-tab-world"
    className="hud-panel"
    hidden={hidden}
    id="hud-panel-world"
    role="tabpanel"
    tabIndex={0}
  >
    {player && (
      <>
        <h2>Defense</h2>
        <p className={activeThreats.length > 0 ? 'threat-active' : ''}>
          {activeThreats.length > 0
            ? `${activeThreats.length} raider threat${activeThreats.length === 1 ? '' : 's'} active`
            : 'No active raider threats'}
        </p>
        <section aria-labelledby="frontier-title">
          <h2 id="frontier-title">Frontier</h2>
          {selectedTile && selectedSector ? (
            <p>
              Selected sector {Math.floor(selectedTile.x / 8)}:{Math.floor(selectedTile.y / 8)} at{' '}
              {selectedTile.x}, {selectedTile.y} —{' '}
              {selectedSector.explored ? 'explored' : 'unexplored'},{' '}
              {selectedSector.claimedBy === 'you'
                ? 'already yours'
                : selectedSector.claimedBy === 'other'
                  ? 'claimed by another settlement'
                  : 'unclaimed'}
              .
            </p>
          ) : (
            <p>Select a tile on the map to choose where to explore or claim.</p>
          )}
          <button
            className="block-button"
            disabled={!selectedTile}
            onClick={() => selectedTile && send({ type: 'explore', ...selectedTile })}
          >
            Explore selected sector
          </button>
          <button
            className="block-button"
            disabled={
              !selectedTile ||
              !player.research.unlocked['territorial-charter'] ||
              !selectedSector?.explored ||
              Boolean(selectedSector?.claimedBy) ||
              !selectedSector?.adjacentToOwnClaim
            }
            onClick={() => selectedTile && send({ type: 'claimTerritory', ...selectedTile })}
          >
            Claim selected sector
          </button>
          {selectedTile && selectedSector && (
            <span className="build-reason">
              {!player.research.unlocked['territorial-charter']
                ? 'Territorial Charter research unlocks claiming.'
                : !selectedSector.explored
                  ? 'Explore this sector before claiming it.'
                  : selectedSector.claimedBy
                    ? selectedSector.claimedBy === 'you'
                      ? 'You already hold this sector.'
                      : 'This sector belongs to another settlement.'
                    : !selectedSector.adjacentToOwnClaim
                      ? 'Claims must touch a sector you already hold.'
                      : 'Ready to claim.'}
            </span>
          )}
        </section>
        <section aria-labelledby="discoveries-title">
          <h2 id="discoveries-title">Landmark discoveries</h2>
          {Object.values(player.discoveries).length === 0 ? (
            <p>Explore new chunks to uncover ruins, fertile groves, and mountain passes.</p>
          ) : (
            <ul>
              {Object.values(player.discoveries).map((discovery) => (
                <li key={`${discovery.x}:${discovery.y}`}>
                  {discovery.kind.replaceAll('-', ' ')} at {discovery.x}, {discovery.y} —{' '}
                  {Object.keys(discovery.reward).length > 0
                    ? Object.entries(discovery.reward)
                        .map(([item, amount]) => `${amount} ${item}`)
                        .join(', ')
                    : 'discovered while inventory was full'}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="strategic-map" aria-labelledby="strategic-map-title">
          <h2 id="strategic-map-title">Strategic world map</h2>
          <p>
            Aggregated explored chunks only. Entities hidden by fog are never included in these
            summaries.
          </p>
          <button
            className="block-button"
            disabled={worldMapLoading}
            onClick={() => requestWorldMap()}
          >
            {worldMapLoading && !worldMap ? 'Loading map…' : 'Refresh strategic map'}
          </button>
          {worldMap && (
            <>
              <p>
                Showing {worldMap.chunks.length} of {worldMap.totalExploredChunks} explored chunks.
              </p>
              <ul className="strategic-map-list">
                {worldMap.chunks.map((chunk) => (
                  <li key={`${chunk.x}:${chunk.y}`}>
                    <strong>
                      {chunk.x}:{chunk.y} {chunk.currentlyVisible ? '(visible)' : '(explored)'}
                    </strong>
                    <span>
                      Resources: {chunk.terrain.ore} ore tiles, {chunk.terrain.wood} timber tiles
                    </span>
                    <span>
                      Own buildings: {chunk.ownBuildingCount}
                      {chunk.currentlyVisible
                        ? ` · foreign buildings: ${chunk.visibleForeignBuildingCount} · threats: ${chunk.visibleThreatCount}`
                        : ''}
                    </span>
                    {chunk.claimedSectors.length > 0 && (
                      <span>
                        Claims:{' '}
                        {chunk.claimedSectors
                          .map(({ ownerId, count }) => `${ownerId} (${count})`)
                          .join(', ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {worldMap.nextCursor && (
                <button
                  className="block-button"
                  disabled={worldMapLoading}
                  onClick={() => requestWorldMap(worldMap.nextCursor)}
                >
                  {worldMapLoading ? 'Loading…' : 'Load more explored chunks'}
                </button>
              )}
            </>
          )}
        </section>
      </>
    )}
  </div>
);
