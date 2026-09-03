import { logisticsLinks as logisticsDefinitions } from '@kings/content';
import type { ClientWorldState } from '@kings/protocol';
import type { Building, SettlementRole } from '@kings/simulation';
import type { Dispatch, SetStateAction } from 'react';
import { displayKey, type ClientPreferences } from '../preferences.js';
import type { BuildMenuEntry, PlacementStatus } from './build-menu.js';
import { buildingProgress, buildingStatus, buildingTierLabel } from './labels.js';
import type { ItemKind, PlayerView, SendCommand, TabPanelProps } from './types.js';

export interface BuildPanelProps extends TabPanelProps {
  readonly state: ClientWorldState | undefined;
  readonly player: PlayerView | undefined;
  readonly playerId: string;
  readonly preferences: ClientPreferences;
  readonly selectedBuildingId: string | undefined;
  readonly buildMenu: readonly BuildMenuEntry[];
  readonly armedKind: Building['kind'] | undefined;
  readonly armedName: string | undefined;
  readonly armedStatus: PlacementStatus | undefined;
  readonly onArm: (kind: Building['kind'] | undefined) => void;
  readonly onInspectBuilding: (building: Building) => void;
  readonly manageableBuildings: readonly Building[];
  readonly roleForBuilding: (building: Building) => SettlementRole | undefined;
  readonly logisticsLinks: readonly ClientWorldState['logisticsLinks'][string][];
  readonly logisticsSources: readonly Building[];
  readonly logisticsTargets: readonly Building[];
  readonly logisticsItems: readonly ItemKind[];
  readonly logisticsSourceId: string;
  readonly setLogisticsSourceId: Dispatch<SetStateAction<string>>;
  readonly logisticsTargetId: string;
  readonly setLogisticsTargetId: Dispatch<SetStateAction<string>>;
  readonly logisticsItem: ItemKind;
  readonly setLogisticsItem: Dispatch<SetStateAction<ItemKind>>;
  readonly send: SendCommand;
}

/** Construction stays compact; selecting a building opens its controls in the inspector. */
export const BuildPanel = ({
  hidden,
  state,
  player,
  playerId,
  preferences,
  selectedBuildingId,
  buildMenu,
  armedKind,
  armedName,
  armedStatus,
  onArm,
  onInspectBuilding,
  manageableBuildings,
  roleForBuilding,
  logisticsLinks,
  logisticsSources,
  logisticsTargets,
  logisticsItems,
  logisticsSourceId,
  setLogisticsSourceId,
  logisticsTargetId,
  setLogisticsTargetId,
  logisticsItem,
  setLogisticsItem,
  send,
}: BuildPanelProps) => {
  const needAttention = manageableBuildings.filter((building) => {
    const tone = buildingStatus(building).tone;
    return tone === 'damaged' || tone === 'blocked';
  }).length;

  return (
    <div
      aria-labelledby="hud-tab-build"
      className="hud-panel"
      hidden={hidden}
      id="hud-panel-build"
      role="tabpanel"
      tabIndex={0}
    >
      <details className="map-help">
        <summary>Map controls and legend</summary>
        <p>
          Map: drag to pan, scroll to zoom, arrows to select, {displayKey(preferences.camera.panUp)}
          /{displayKey(preferences.camera.panLeft)}/{displayKey(preferences.camera.panDown)}/
          {displayKey(preferences.camera.panRight)} to pan. Boulders mark ore deposits and conifers
          mark timber groves, and a worked range shows cut stone. An outlined sector is claimed —
          green is yours, blue is another settlement&apos;s.
        </p>
      </details>
      {state && !player && <p>Loading world…</p>}
      {player && (
        <>
          <h2>Construction</h2>
          {armedKind && armedName && (
            <div className="placement-banner" role="status">
              <p>
                <strong>Placing {armedName.toLowerCase()}</strong> —{' '}
                {armedStatus?.valid ? 'click a tile to place it' : armedStatus?.reason}
              </p>
              <p className="placement-hint">
                Shift-click keeps placing. Escape cancels.
                <button onClick={() => onArm(undefined)}>Cancel</button>
              </p>
            </div>
          )}
          <ul className="build-menu">
            {buildMenu.map((entry) => {
              const armed = armedKind === entry.kind;
              return (
                <li key={entry.kind}>
                  <button
                    aria-pressed={armed}
                    className={armed ? 'build-option armed' : 'build-option'}
                    disabled={Boolean(entry.unavailable)}
                    onClick={() => onArm(armed ? undefined : entry.kind)}
                    {...(entry.hotkey ? { 'aria-keyshortcuts': entry.hotkey } : {})}
                  >
                    {entry.hotkey && (
                      <span aria-hidden="true" className="hotkey">
                        {entry.hotkey}
                      </span>
                    )}
                    <span className="build-option-name">Place {entry.name.toLowerCase()}</span>
                    <span className="build-cost">{entry.costLabel}</span>
                  </button>
                  {(entry.unavailable ?? entry.description) && (
                    <span className="build-reason">{entry.unavailable ?? entry.description}</span>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="section-heading-row">
            <h2>Buildings</h2>
            <span className="building-count">
              {manageableBuildings.length} total
              {needAttention > 0
                ? ` · ${needAttention} alert${needAttention === 1 ? '' : 's'}`
                : ''}
            </span>
          </div>
          <div className="building-list" aria-label="Managed buildings">
            {manageableBuildings.map((building) => {
              const status = buildingStatus(building);
              const progress = buildingProgress(building);
              const selected = building.id === selectedBuildingId;
              return (
                <section className={selected ? 'building selected' : 'building'} key={building.id}>
                  <button
                    aria-pressed={selected}
                    className="building-summary"
                    onClick={() => onInspectBuilding(building)}
                    type="button"
                  >
                    <span className="building-name">{buildingTierLabel(building)}</span>
                    <span className="building-site">
                      {building.x}, {building.y}
                    </span>
                    <span className={`building-state ${status.tone}`}>{status.label}</span>
                    {progress && (
                      <span aria-hidden="true" className="building-progress" title={progress.label}>
                        <span
                          className="building-progress-fill"
                          style={{
                            width: `${Math.round(
                              (100 * Math.min(progress.done, progress.total)) / progress.total,
                            )}%`,
                          }}
                        />
                      </span>
                    )}
                  </button>
                </section>
              );
            })}
          </div>

          <details className="automation-panel">
            <summary>
              <strong>Automation</strong>
              <span>{logisticsLinks.length} active links</span>
            </summary>
            <p>
              Link completed storage or production buildings to a producer. Each carrier loads up to{' '}
              {logisticsDefinitions.internalInventory.carrierCapacity} items; paving and Engineering
              shorten its round trip.
            </p>
            <label htmlFor="logistics-source">Source</label>
            <select
              id="logistics-source"
              value={logisticsSourceId}
              onChange={(event) => setLogisticsSourceId(event.target.value)}
            >
              <option value="">Choose source</option>
              {logisticsSources.map((building) => (
                <option key={building.id} value={building.id}>
                  {building.id}
                </option>
              ))}
            </select>
            <label htmlFor="logistics-target">Producer target</label>
            <select
              id="logistics-target"
              value={logisticsTargetId}
              onChange={(event) => setLogisticsTargetId(event.target.value)}
            >
              <option value="">Choose producer</option>
              {logisticsTargets.map((building) => (
                <option key={building.id} value={building.id}>
                  {building.id}
                </option>
              ))}
            </select>
            <label htmlFor="logistics-item">Input item</label>
            <select
              id="logistics-item"
              value={logisticsItems.includes(logisticsItem) ? logisticsItem : ''}
              onChange={(event) => setLogisticsItem(event.target.value as ItemKind)}
            >
              <option value="">Choose input</option>
              {logisticsItems.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <button
              className="block-button"
              disabled={
                !logisticsSourceId || !logisticsTargetId || !logisticsItems.includes(logisticsItem)
              }
              onClick={() =>
                send({
                  type: 'createLogisticsLink',
                  sourceBuildingId: logisticsSourceId,
                  targetBuildingId: logisticsTargetId,
                  item: logisticsItem,
                })
              }
            >
              Create input link
            </button>
            {logisticsLinks.map((link) => {
              const source = state?.buildings[link.sourceBuildingId];
              const target = state?.buildings[link.targetBuildingId];
              const carrier = link.carrierId ? state?.carriers[link.carrierId] : undefined;
              const targetStock = target?.inventory[link.item] ?? 0;
              const recentDelivered = link.recentDeliveries.reduce(
                (total, delivery) => total + delivery.amount,
                0,
              );
              const canRemove =
                link.ownerId === playerId ||
                (source &&
                  target &&
                  ['owner', 'logistics'].includes(roleForBuilding(source) ?? '') &&
                  ['owner', 'logistics'].includes(roleForBuilding(target) ?? ''));
              return (
                <p className="logistics-link" key={link.id}>
                  {link.sourceBuildingId} → {link.targetBuildingId} ({link.item},{' '}
                  {link.capacityPerTrip}/trip, {link.routeDistance ?? 0} route tiles,{' '}
                  {link.status.replaceAll('-', ' ')}
                  {carrier ? `, carrier at ${carrier.x}, ${carrier.y}` : ''})
                  <span>
                    Stock {targetStock}; refill below {link.targetMinimum} up to{' '}
                    {link.targetMaximum}. Delivered {recentDelivered} in the last 60 ticks ({' '}
                    {link.deliveredTotal} lifetime).
                  </span>
                  <label>
                    Refill below
                    <input
                      aria-label={`Minimum stock for ${link.id}`}
                      defaultValue={link.targetMinimum}
                      disabled={!canRemove}
                      key={`${link.id}-minimum-${link.targetMinimum}`}
                      min={0}
                      max={link.targetMaximum}
                      type="number"
                      onBlur={(event) => {
                        const minimum = Number(event.currentTarget.value);
                        if (Number.isSafeInteger(minimum) && minimum !== link.targetMinimum)
                          send({
                            type: 'setLogisticsStockTarget',
                            linkId: link.id,
                            minimum,
                            maximum: link.targetMaximum,
                          });
                      }}
                    />
                  </label>
                  <label>
                    Refill to
                    <input
                      aria-label={`Maximum stock for ${link.id}`}
                      defaultValue={link.targetMaximum}
                      disabled={!canRemove}
                      key={`${link.id}-maximum-${link.targetMaximum}`}
                      min={link.targetMinimum}
                      max={100}
                      type="number"
                      onBlur={(event) => {
                        const maximum = Number(event.currentTarget.value);
                        if (Number.isSafeInteger(maximum) && maximum !== link.targetMaximum)
                          send({
                            type: 'setLogisticsStockTarget',
                            linkId: link.id,
                            minimum: link.targetMinimum,
                            maximum,
                          });
                      }}
                    />
                  </label>
                  <select
                    aria-label={`Priority for ${link.id}`}
                    disabled={!canRemove}
                    value={link.priority}
                    onChange={(event) =>
                      send({
                        type: 'setLogisticsPriority',
                        linkId: link.id,
                        priority: Number(event.target.value),
                      })
                    }
                  >
                    <option value={0}>Paused</option>
                    <option value={1}>Normal</option>
                    <option value={2}>High</option>
                    <option value={3}>Urgent</option>
                  </select>
                  <button
                    disabled={!canRemove}
                    onClick={() => send({ type: 'removeLogisticsLink', linkId: link.id })}
                  >
                    Remove
                  </button>
                </p>
              );
            })}
          </details>
        </>
      )}
    </div>
  );
};
