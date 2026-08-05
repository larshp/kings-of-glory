import { logisticsLinks as logisticsDefinitions } from '@kings/content';
import type { Dispatch, SetStateAction } from 'react';
import type { ClientWorldState, TerrainTile } from '@kings/protocol';
import type { Building, SettlementRole } from '@kings/simulation';
import { displayKey, type ClientPreferences } from '../preferences.js';
import type { PickedEntity } from '../WorldCanvas.js';
import {
  buildingLabel,
  buildingTierLabel,
  extractorForBuilding,
  extractionDurationForBuilding,
  ITEM_KINDS,
  renewerForBuilding,
  recipeDurationForBuilding,
  recipeForBuilding,
  recipeOptionsForBuilding,
  technologyCostLabel,
  upgradeBenefitLabel,
  upgradeForBuilding,
  usesWorkers,
} from './labels.js';
import type { ItemKind, PlayerView, SendCommand, TabPanelProps, Tile } from './types.js';

export interface BuildMenuEntry {
  readonly commandType: string;
  readonly kind: Building['kind'];
  readonly label: string;
  readonly disabled: boolean;
  readonly reason: string;
}

export interface BuildPanelProps extends TabPanelProps {
  readonly state: ClientWorldState | undefined;
  readonly player: PlayerView | undefined;
  readonly playerId: string;
  readonly preferences: ClientPreferences;
  readonly selectedTile: Tile | undefined;
  readonly selectedEntity: PickedEntity | undefined;
  readonly selectedBuildingId: string | undefined;
  readonly selectedResource: TerrainTile | undefined;
  readonly selectedTerritoryOwner: string | undefined;
  readonly actionTile: Tile;
  readonly placement: Tile | undefined;
  readonly buildMenu: readonly BuildMenuEntry[];
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
  readonly transfer: (
    building: Building,
    item: ItemKind,
    direction: 'toBuilding' | 'toPlayer',
  ) => void;
  readonly send: SendCommand;
}

/** Moment-to-moment play: the selected tile, construction menu, and logistics routing. */
export const BuildPanel = ({
  hidden,
  state,
  player,
  playerId,
  preferences,
  selectedTile,
  selectedEntity,
  selectedBuildingId,
  selectedResource,
  selectedTerritoryOwner,
  actionTile,
  placement,
  buildMenu,
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
  transfer,
  send,
}: BuildPanelProps) => (
  <div
    aria-labelledby="hud-tab-build"
    className="hud-panel"
    hidden={hidden}
    id="hud-panel-build"
    role="tabpanel"
    tabIndex={0}
  >
    <p className="map-help">
      Map: drag to pan, scroll to zoom, arrows to select, {displayKey(preferences.camera.panUp)}/
      {displayKey(preferences.camera.panLeft)}/{displayKey(preferences.camera.panDown)}/
      {displayKey(preferences.camera.panRight)} to pan. Boulders mark ore deposits and conifers mark
      timber groves, and a worked range shows cut stone; all three thin out as they are used. An
      outlined sector is claimed — green is yours, blue is another settlement&apos;s. Timber and ore
      slow scouts unless paved, while a watchtower beside a mountain gains extra range.
    </p>
    {state && !player && <p>Loading world…</p>}
    {player && (
      <>
        <p>
          Selected tile: {actionTile.x}, {actionTile.y}
          {selectedResource === 'ore'
            ? ' (ore deposit)'
            : selectedResource === 'wood'
              ? ' (timber grove)'
              : ''}
        </p>
        {selectedEntity && (
          <p>
            Selected {selectedEntity.type}:{' '}
            {selectedEntity.type === 'building'
              ? (() => {
                  const selected = state?.buildings[selectedEntity.id];
                  return selected ? buildingLabel(selected.kind) : selectedEntity.id;
                })()
              : `raider ${selectedEntity.id}`}
          </p>
        )}
        {selectedTile && (
          <p>
            Sector: {selectedTerritoryOwner ? `claimed by ${selectedTerritoryOwner}` : 'unclaimed'}
          </p>
        )}
        <p className={selectedTile && !placement ? 'threat-active' : ''}>
          {selectedTile
            ? placement
              ? 'Selected tile is buildable'
              : 'Selected tile cannot be built on'
            : 'Select a tile to choose a build site'}
        </p>
        <button
          disabled={selectedResource !== 'ore' && selectedResource !== 'wood'}
          onClick={() =>
            send(
              { type: 'gather', ...actionTile },
              selectedResource === 'wood' ? 'Gathered wood.' : 'Gathered ore.',
            )
          }
        >
          Gather{' '}
          {selectedResource === 'ore' ? 'ore' : selectedResource === 'wood' ? 'wood' : 'resource'}
        </button>
        <button
          disabled={
            !placement ||
            !player.research.unlocked.engineering ||
            player.inventory.wood < 1 ||
            Boolean(state?.roads[`${placement.x}:${placement.y}`])
          }
          onClick={() => placement && send({ type: 'placeRoad', ...placement })}
        >
          Build road (1 wood)
        </button>
        {!player.research.unlocked.engineering && (
          <span className="build-reason">Engineering research unlocks roads.</span>
        )}
        <h2>Construction</h2>
        <ul className="build-menu">
          {buildMenu.map((entry) => (
            <li key={entry.kind}>
              <button
                disabled={entry.disabled}
                onClick={() => placement && send({ type: entry.commandType, ...placement })}
              >
                {entry.label}
              </button>
              {entry.reason && <span className="build-reason">{entry.reason}</span>}
            </li>
          ))}
        </ul>
        <h2>Buildings</h2>
        {manageableBuildings.map((building) => {
          const role = roleForBuilding(building);
          const canBuild = role === 'owner' || role === 'builder';
          const canMoveItems = role === 'owner' || role === 'logistics';
          const recipe = recipeForBuilding(building);
          const recipeOptions = recipeOptionsForBuilding(building);
          const upgrade = upgradeForBuilding(building);
          // A tier is charged to the building's owner, so the panel can only judge the cost
          // for buildings this player owns. The server remains the authority either way.
          const upgradeOwner = building.ownerId === playerId ? player : undefined;
          const upgradeLocked = Boolean(
            upgrade &&
            upgradeOwner &&
            upgrade.requiredTechnology &&
            !upgradeOwner.research.unlocked[
              upgrade.requiredTechnology as keyof typeof upgradeOwner.research.unlocked
            ],
          );
          const upgradeAffordable =
            !upgrade ||
            !upgradeOwner ||
            Object.entries(upgrade.cost).every(
              ([item, amount]) =>
                upgradeOwner.inventory[item as keyof typeof upgradeOwner.inventory] >= amount,
            );
          const configurationTargets = manageableBuildings.filter(
            (candidate) =>
              candidate.id !== building.id &&
              candidate.kind === building.kind &&
              candidate.constructionTicks === 0,
          );
          const missingInputs = recipe
            ? Object.entries(recipe.input).filter(
                ([item, amount]) =>
                  building.inventory[item as keyof typeof building.inventory] < amount,
              )
            : [];
          return (
            <section
              className={building.id === selectedBuildingId ? 'building selected' : 'building'}
              key={building.id}
            >
              <strong>{buildingTierLabel(building)}</strong>
              {building.id === selectedBuildingId && <span>Selected on the map</span>}
              {building.ownerId !== playerId && <span>Shared by {building.ownerId}</span>}
              <span>
                Health {building.health}/{building.maxHealth}
              </span>
              {building.health < building.maxHealth && (
                <span className="alert">
                  Damaged by a threat or acid rain. Repair to restore production and protect this
                  building.
                </span>
              )}
              <span>
                Inventory:{' '}
                {ITEM_KINDS.map((item) => `${item} ${building.inventory[item]}`).join(' · ')}
              </span>
              {building.populationCapacity > 0 && (
                <span>Housing capacity: {building.populationCapacity}</span>
              )}
              {building.constructionTicks > 0 ? (
                <>
                  <span>
                    {building.upgradeTier ? 'Upgrade' : 'Construction'}:{' '}
                    {building.constructionTicks} worker ticks
                  </span>
                  {Object.values(building.constructionMaterials).some((amount) => amount > 0) && (
                    <span>
                      Delivery remaining:{' '}
                      {ITEM_KINDS.filter((item) => building.constructionMaterials[item] > 0)
                        .map((item) => `${item} ${building.constructionMaterials[item]}`)
                        .join(' · ')}
                    </span>
                  )}
                </>
              ) : (
                <>
                  {recipe && (
                    <>
                      {recipeOptions.length > 1 && (
                        <label>
                          Recipe
                          <select
                            disabled={!canBuild || building.progress > 0}
                            value={building.recipeId ?? ''}
                            onChange={(event) =>
                              send({
                                type: 'setRecipe',
                                buildingId: building.id,
                                recipeId: event.target.value,
                              })
                            }
                          >
                            {recipeOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.id}: {technologyCostLabel(option.input)} →{' '}
                                {technologyCostLabel(option.output)}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <span>
                        Production: {building.progress}/{recipeDurationForBuilding(building)} ticks
                      </span>
                      <span>Machine: {building.productionState.replaceAll('-', ' ')}</span>
                      {building.health === building.maxHealth &&
                        building.jobPriority > 0 &&
                        building.progress === 0 &&
                        missingInputs.length > 0 && (
                          <span className="alert">
                            Stalled: needs{' '}
                            {missingInputs
                              .map(([item, amount]) => `${amount} ${item}`)
                              .join(' and ')}
                            .
                          </span>
                        )}
                    </>
                  )}
                  {extractorForBuilding(building) && (
                    <>
                      <span>
                        Extraction: {building.progress}/{extractionDurationForBuilding(building)}{' '}
                        ticks per {extractorForBuilding(building)!.item}
                      </span>
                      <span>Machine: {building.productionState.replaceAll('-', ' ')}</span>
                      {building.productionState === 'blocked-input' && (
                        <span className="alert">
                          Stalled: every deposit within {extractorForBuilding(building)!.range}{' '}
                          tiles is exhausted. Demolish and rebuild beside another deposit.
                        </span>
                      )}
                      {building.productionState === 'blocked-output' && (
                        <span className="alert">
                          Stalled: this store is full. Withdraw items or link it to storage.
                        </span>
                      )}
                    </>
                  )}
                  {renewerForBuilding(building) && (
                    <>
                      <span>
                        Renewal cycle: {building.progress} ticks remaining; water and fertile groves
                        accelerate restoration
                      </span>
                      <span>Machine: {building.productionState.replaceAll('-', ' ')}</span>
                    </>
                  )}
                  {usesWorkers(building) && (
                    <>
                      <label>
                        Job priority
                        <select
                          disabled={!canBuild}
                          value={building.jobPriority}
                          onChange={(event) =>
                            send({
                              type: 'setJobPriority',
                              buildingId: building.id,
                              priority: Number(event.target.value),
                            })
                          }
                        >
                          <option value={0}>Paused</option>
                          <option value={1}>Normal</option>
                          <option value={2}>High</option>
                          <option value={3}>Urgent</option>
                        </select>
                      </label>
                      {configurationTargets.length > 0 && (
                        <label>
                          Copy settings to
                          <select
                            defaultValue=""
                            disabled={!canBuild || building.progress > 0}
                            onChange={(event) => {
                              if (!event.target.value) return;
                              send({
                                type: 'copyBuildingConfiguration',
                                sourceBuildingId: building.id,
                                targetBuildingId: event.target.value,
                              });
                              event.target.value = '';
                            }}
                          >
                            <option value="">Choose producer</option>
                            {configurationTargets.map((target) => (
                              <option key={target.id} value={target.id}>
                                {target.id}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </>
                  )}
                  {building.inventoryCapacity > 0 &&
                    ITEM_KINDS.map((item) => (
                      <span className="item-transfer" key={item}>
                        <button
                          disabled={!canMoveItems || player.inventory[item] < 1}
                          onClick={() => transfer(building, item, 'toBuilding')}
                        >
                          Load 1 {item}
                        </button>
                        <button
                          disabled={!canMoveItems || building.inventory[item] < 1}
                          onClick={() => transfer(building, item, 'toPlayer')}
                        >
                          Take 1 {item}
                        </button>
                      </span>
                    ))}
                  {building.kind === 'smelter' && (
                    <button
                      disabled={!canBuild}
                      onClick={() => send({ type: 'smelt', buildingId: building.id })}
                    >
                      Start smelting
                    </button>
                  )}
                  <button
                    disabled={!canBuild || building.health >= building.maxHealth}
                    onClick={() => send({ type: 'repair', buildingId: building.id })}
                  >
                    Repair
                  </button>
                  {upgrade && building.tier < upgrade.tier && (
                    <>
                      <button
                        disabled={
                          !canBuild || upgradeLocked || !upgradeAffordable || building.progress > 0
                        }
                        onClick={() => send({ type: 'upgradeBuilding', buildingId: building.id })}
                      >
                        Upgrade to tier {upgrade.tier} ({technologyCostLabel(upgrade.cost)})
                      </button>
                      <span className="build-reason">
                        {upgradeLocked
                          ? 'Masonry research unlocks building tiers.'
                          : !upgradeAffordable
                            ? `Needs ${technologyCostLabel(upgrade.cost)} in the owner's stock.`
                            : building.progress > 0
                              ? 'Waits for the running batch to finish.'
                              : `${upgradeBenefitLabel(building)}; stops work for ${upgrade.constructionTicks} worker ticks.`}
                      </span>
                    </>
                  )}
                  {building.kind !== 'settlement-center' && (
                    <button
                      disabled={!canBuild}
                      onClick={() => send({ type: 'demolish', buildingId: building.id })}
                    >
                      Demolish
                    </button>
                  )}
                </>
              )}
              {building.constructionTicks > 0 && building.kind !== 'settlement-center' && (
                <button
                  disabled={!canBuild}
                  onClick={() => send({ type: 'cancelConstruction', buildingId: building.id })}
                >
                  Cancel construction
                </button>
              )}
            </section>
          );
        })}
        <section className="automation-panel" aria-labelledby="automation-title">
          <h2 id="automation-title">Automation</h2>
          <p>
            Link completed storage or production buildings to a producer. Higher-priority links
            reserve target capacity first. Each link has one carrier: it loads up to{' '}
            {logisticsDefinitions.internalInventory.carrierCapacity} items, walks the route,
            unloads, and walks back, so distance sets a link&apos;s real throughput. Paving the
            route and Engineering research both shorten the round trip.
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
            onChange={(event) =>
              setLogisticsItem(event.target.value as 'ore' | 'wood' | 'ingot' | 'tool')
            }
          >
            <option value="">Choose input</option>
            {logisticsItems.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <button
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
        </section>
      </>
    )}
  </div>
);
