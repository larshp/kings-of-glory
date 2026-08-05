import type { PlayerView, SendCommand, TabPanelProps, WorldMapView } from './types.js';

export interface WorldPanelProps extends TabPanelProps {
  readonly player: PlayerView | undefined;
  readonly activeThreats: readonly { readonly id: string }[];
  readonly frontier: { readonly x: number; readonly y: number };
  readonly worldMap: WorldMapView | undefined;
  readonly worldMapLoading: boolean;
  readonly requestWorldMap: (after?: string) => void;
  readonly send: SendCommand;
}

/** Defense summary and the aggregated strategic map of explored chunks. */
export const WorldPanel = ({
  hidden,
  player,
  activeThreats,
  frontier,
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
        <button onClick={() => send({ type: 'explore', ...frontier })}>Explore frontier</button>
        <button
          disabled={!player.research.unlocked['territorial-charter']}
          onClick={() => send({ type: 'claimTerritory', ...frontier })}
        >
          Claim frontier sector
        </button>
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
          <button disabled={worldMapLoading} onClick={() => requestWorldMap()}>
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
