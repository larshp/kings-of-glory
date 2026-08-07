import type { ClientWorldState, TerrainTile } from '@kings/protocol';
import type { Building, SettlementRole } from '@kings/simulation';
import type { PickedEntity } from '../WorldCanvas.js';
import {
  buildingProgress,
  buildingStatus,
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
import type { ItemKind, PlayerView, SendCommand, Tile } from './types.js';

export interface ContextInspectorProps {
  readonly state: ClientWorldState | undefined;
  readonly player: PlayerView | undefined;
  readonly playerId: string;
  readonly selectedTile: Tile | undefined;
  readonly selectedEntity: PickedEntity | undefined;
  readonly selectedBuildingId: string | undefined;
  readonly selectedResource: TerrainTile | undefined;
  readonly selectedTerritoryOwner: string | undefined;
  readonly actionTile: Tile;
  readonly placement: Tile | undefined;
  readonly manageableBuildings: readonly Building[];
  readonly roleForBuilding: (building: Building) => SettlementRole | undefined;
  readonly transfer: (
    building: Building,
    item: ItemKind,
    direction: 'toBuilding' | 'toPlayer',
  ) => void;
  readonly send: SendCommand;
  readonly onClose: () => void;
}

/** The selected map object stays actionable without displacing the current game mode. */
export const ContextInspector = ({
  state,
  player,
  playerId,
  selectedTile,
  selectedEntity,
  selectedBuildingId,
  selectedResource,
  selectedTerritoryOwner,
  actionTile,
  placement,
  manageableBuildings,
  roleForBuilding,
  transfer,
  send,
  onClose,
}: ContextInspectorProps) => {
  if (!player || (!selectedTile && !selectedEntity)) return null;

  const building = selectedBuildingId ? state?.buildings[selectedBuildingId] : undefined;
  const threat = selectedEntity?.type === 'threat' ? state?.threats[selectedEntity.id] : undefined;
  const title = building
    ? buildingTierLabel(building)
    : threat
      ? 'Raider threat'
      : `Tile ${actionTile.x}, ${actionTile.y}`;

  const role = building ? roleForBuilding(building) : undefined;
  const canBuild = role === 'owner' || role === 'builder';
  const canMoveItems = role === 'owner' || role === 'logistics';
  const recipe = building ? recipeForBuilding(building) : undefined;
  const recipeOptions = building ? recipeOptionsForBuilding(building) : [];
  const upgrade = building ? upgradeForBuilding(building) : undefined;
  const upgradeOwner = building?.ownerId === playerId ? player : undefined;
  const buildingOwner = building ? state?.players[building.ownerId] : undefined;
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
  const configurationTargets = building
    ? manageableBuildings.filter(
        (candidate) =>
          candidate.id !== building.id &&
          candidate.kind === building.kind &&
          candidate.constructionTicks === 0,
      )
    : [];
  const missingInputs =
    building && recipe
      ? Object.entries(recipe.input).filter(
          ([item, amount]) => building.inventory[item as keyof typeof building.inventory] < amount,
        )
      : [];
  const status = building ? buildingStatus(building) : undefined;
  const progress = building ? buildingProgress(building) : undefined;

  return (
    <aside className="context-inspector" aria-labelledby="context-inspector-title">
      <header className="context-inspector-header">
        <div>
          <span className="eyebrow">Selected</span>
          <h2 id="context-inspector-title">{title}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
        >
          ×
        </button>
      </header>

      <div className="context-inspector-body">
        <section className="selection-summary" aria-label="Selection summary">
          <span>
            Position {actionTile.x}, {actionTile.y}
          </span>
          {selectedTile && (
            <span>
              Sector {selectedTerritoryOwner ? `claimed by ${selectedTerritoryOwner}` : 'unclaimed'}
            </span>
          )}
          {selectedResource === 'ore' && <span>Resource: Ore deposit</span>}
          {selectedResource === 'wood' && <span>Resource: Timber grove</span>}
          {threat && (
            <span className="threat-active">
              {threat.health} health · targeting {threat.targetBuildingId}
            </span>
          )}
          {!building && (
            <span className={selectedTile && !placement ? 'threat-active' : ''}>
              {selectedTile
                ? placement
                  ? 'Selected tile is buildable'
                  : 'Selected tile cannot be built on'
                : 'Select a tile to choose a build site'}
            </span>
          )}
        </section>

        {!building && (
          <section className="context-actions" aria-labelledby="tile-actions-title">
            <h3 id="tile-actions-title">Tile actions</h3>
            <button
              className="block-button"
              disabled={selectedResource !== 'ore' && selectedResource !== 'wood'}
              onClick={() =>
                send(
                  { type: 'gather', ...actionTile },
                  selectedResource === 'wood' ? 'Gathered wood.' : 'Gathered ore.',
                )
              }
            >
              Gather{' '}
              {selectedResource === 'ore'
                ? 'ore'
                : selectedResource === 'wood'
                  ? 'wood'
                  : 'resource'}
            </button>
            <button
              className="block-button"
              disabled={selectedResource !== 'ore' && selectedResource !== 'wood'}
              onClick={() =>
                send(
                  { type: 'gather', ...actionTile, amount: 5 },
                  `Gathering order queued for ${selectedResource}.`,
                )
              }
            >
              Queue 5{' '}
              {selectedResource === 'ore'
                ? 'ore'
                : selectedResource === 'wood'
                  ? 'wood'
                  : 'resources'}
            </button>
            {player.gatherOrder && (
              <span className="build-reason">
                One settler is gathering {player.gatherOrder.remaining} more{' '}
                {player.gatherOrder.item} at {player.gatherOrder.x}, {player.gatherOrder.y}.
                <button onClick={() => send({ type: 'cancelGatherOrder' })}>Cancel order</button>
              </span>
            )}
            <button
              className="block-button"
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
          </section>
        )}

        {building && status && (
          <section className="building-inspector" aria-label={`${title} controls`}>
            <div className="inspector-status-row">
              <span className={`building-state ${status.tone}`}>{status.label}</span>
              <span>
                Health {building.health}/{building.maxHealth}
              </span>
            </div>
            {progress && (
              <div className="inspector-progress">
                <span>{progress.label}</span>
                <span className="building-progress" aria-hidden="true">
                  <span
                    className="building-progress-fill"
                    style={{
                      width: `${Math.round(
                        (100 * Math.min(progress.done, progress.total)) / progress.total,
                      )}%`,
                    }}
                  />
                </span>
              </div>
            )}
            {building.ownerId !== playerId && <span>Shared by {building.ownerId}</span>}
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
                  {building.upgradeTier ? 'Upgrade' : 'Construction'}: {building.constructionTicks}{' '}
                  worker ticks
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
                            <option
                              disabled={Boolean(
                                option.requiredTechnology &&
                                !buildingOwner?.research.unlocked[
                                  option.requiredTechnology as keyof typeof player.research.unlocked
                                ],
                              )}
                              key={option.id}
                              value={option.id}
                            >
                              {option.id}: {technologyCostLabel(option.input)} →{' '}
                              {technologyCostLabel(option.output)}
                              {option.requiredTechnology
                                ? ` (${option.requiredTechnology} path)`
                                : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <span>
                      Production: {building.progress}/{recipeDurationForBuilding(building)} ticks
                    </span>
                    {building.health === building.maxHealth &&
                      building.jobPriority > 0 &&
                      building.progress === 0 &&
                      missingInputs.length > 0 && (
                        <span className="alert">
                          Stalled: needs{' '}
                          {missingInputs.map(([item, amount]) => `${amount} ${item}`).join(' and ')}
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
                    {building.productionState === 'blocked-input' && (
                      <span className="alert">
                        Stalled: every deposit within {extractorForBuilding(building)!.range} tiles
                        is exhausted. Demolish and rebuild beside another deposit.
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
                  <span>
                    Renewal cycle: {building.progress} ticks remaining; water and fertile groves
                    accelerate restoration
                  </span>
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
                <span className="building-actions">
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
                  {building.kind !== 'settlement-center' && (
                    <button
                      className="danger-button"
                      disabled={!canBuild}
                      onClick={() => send({ type: 'demolish', buildingId: building.id })}
                    >
                      Demolish
                    </button>
                  )}
                </span>
                {upgrade && building.tier < upgrade.tier && (
                  <>
                    <button
                      className="block-button"
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
              </>
            )}
            {building.constructionTicks > 0 && building.kind !== 'settlement-center' && (
              <button
                className="block-button"
                disabled={!canBuild}
                onClick={() => send({ type: 'cancelConstruction', buildingId: building.id })}
              >
                Cancel construction
              </button>
            )}
          </section>
        )}
      </div>
    </aside>
  );
};
