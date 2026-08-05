import type { Dispatch, SetStateAction } from 'react';
import { technologies } from '@kings/content';
import type { ClientWorldState } from '@kings/protocol';
import type { Plot } from '@kings/simulation';
import {
  informationCategories,
  type InformationCategory,
  type InformationEntry,
} from '../information-search.js';
import type { NotificationSeverity } from '../notifications.js';
import { technologyCostLabel } from './labels.js';
import type { PlayerView, SendCommand, TabPanelProps } from './types.js';

type AlertEntry = InformationEntry & { readonly severity: NotificationSeverity };

export interface SettlementPanelProps extends TabPanelProps {
  readonly player: PlayerView | undefined;
  readonly plot: Plot | undefined;
  readonly progressionEra: string;
  readonly onboardingSteps: readonly { readonly complete: boolean; readonly text: string }[];
  readonly onboardingReservation: ClientWorldState['onboardingReservations'][string] | undefined;
  readonly hasCompletedHearth: boolean;
  readonly exploredChunkCount: number;
  readonly visibleChunkCount: number;
  readonly canAffordTechnology: (
    cost: Readonly<Partial<Record<'ore' | 'wood' | 'ingot' | 'tool', number>>>,
  ) => boolean;
  readonly activeAlertEntries: readonly AlertEntry[];
  readonly alertGroups: readonly {
    readonly severity: NotificationSeverity;
    readonly notifications: readonly AlertEntry[];
  }[];
  readonly informationQuery: string;
  readonly setInformationQuery: Dispatch<SetStateAction<string>>;
  readonly informationCategory: InformationCategory | 'all';
  readonly informationResults: readonly InformationEntry[];
  readonly setInformationCategory: Dispatch<SetStateAction<InformationCategory | 'all'>>;
  readonly send: SendCommand;
}

/** Settlement progression, onboarding guidance, alerts, and the information search. */
export const SettlementPanel = ({
  hidden,
  player,
  plot,
  progressionEra,
  onboardingSteps,
  onboardingReservation,
  hasCompletedHearth,
  exploredChunkCount,
  visibleChunkCount,
  canAffordTechnology,
  activeAlertEntries,
  alertGroups,
  informationQuery,
  setInformationQuery,
  informationCategory,
  setInformationCategory,
  informationResults,
  send,
}: SettlementPanelProps) => (
  <div
    aria-labelledby="hud-tab-settlement"
    className="hud-panel"
    hidden={hidden}
    id="hud-panel-settlement"
    role="tabpanel"
    tabIndex={0}
  >
    {player && (
      <>
        <p>
          Plot: {plot?.x}, {plot?.y}
        </p>
        <p>
          Settlers {player.population.total}/{player.population.capacity} · Satisfaction{' '}
          {player.population.satisfaction}
        </p>
        <p>
          Jobs: {player.population.employed} employed · {player.population.unemployed} available
        </p>
        <p>
          Exploration: {exploredChunkCount} explored · {visibleChunkCount} currently visible
        </p>
        <section className="notification-center" aria-labelledby="notification-center-title">
          <h2 id="notification-center-title">Notifications</h2>
          {activeAlertEntries.length === 0 ? (
            <p className="notification-clear">No active settlement alerts.</p>
          ) : (
            <>
              <p aria-live="polite">
                {activeAlertEntries.length} active alert
                {activeAlertEntries.length === 1 ? '' : 's'}, grouped by severity.
              </p>
              {alertGroups.map((group) => (
                <details className={`notification-group ${group.severity}`} key={group.severity}>
                  <summary>
                    {group.severity}: {group.notifications.length}
                  </summary>
                  <ul>
                    {group.notifications.map((alert) => (
                      <li key={alert.id}>
                        <strong>{alert.title}</strong> — {alert.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </>
          )}
        </section>
        <section className="settlement-stats" aria-labelledby="settlement-stats-title">
          <h2 id="settlement-stats-title">Settlement needs</h2>
          <p>
            Shelter: {player.population.capacity >= player.population.total ? 'met' : 'shortage'} (
            {player.population.total}/{player.population.capacity})
          </p>
          <p>
            Work: {player.population.employed}/{player.population.total} settlers assigned
          </p>
          <p>Wellbeing: {hasCompletedHearth ? 'hearth active' : 'hearth needed'}</p>
        </section>
        <section className="onboarding" aria-labelledby="getting-started-title">
          <h2 id="getting-started-title">Getting started</h2>
          {onboardingReservation && (
            <p className="onboarding-reservation">
              {onboardingReservation.securedTick === null
                ? `Starter reservation is temporary until your smelter is complete. Active commands extend it; current expiry is world tick ${onboardingReservation.expiresTick}.`
                : `Starter reservation secured at world tick ${onboardingReservation.securedTick}.`}
            </p>
          )}
          {/* The next step lives in the always-visible HUD header. */}
          <ol>
            {onboardingSteps.map((step) => (
              <li className={step.complete ? 'complete' : undefined} key={step.text}>
                {step.complete ? 'Done: ' : ''}
                {step.text}
              </li>
            ))}
          </ol>
        </section>
        <h2>Progression</h2>
        <p>
          <strong>{progressionEra}</strong>
        </p>
        <ol className="progression-milestones">
          <li className="complete">Founding: establish production and shelter.</li>
          <li className={player.research.unlocked.metallurgy ? 'complete' : undefined}>
            Industry: research Metallurgy to unlock workshops and watchtowers.
          </li>
          <li className={player.research.unlocked['territorial-charter'] ? 'complete' : undefined}>
            Expansion: research the Territorial Charter to claim explored sectors.
          </li>
          <li
            className={
              player.research.unlocked.engineering || player.research.unlocked.stewardship
                ? 'complete'
                : undefined
            }
          >
            Development: choose Engineering for road logistics or Stewardship for renewable timber.
            This choice is permanent.
          </li>
        </ol>
        <p>
          Research: {player.research.activeTechnology ?? 'idle'} ({player.research.ticksRemaining}{' '}
          ticks)
        </p>
        <button
          disabled={
            Boolean(player.research.activeTechnology) ||
            player.research.unlocked.metallurgy ||
            !canAffordTechnology(technologies.metallurgy.cost)
          }
          onClick={() => send({ type: 'research', technologyId: 'metallurgy' })}
        >
          Research {technologies.metallurgy.displayName} (
          {technologyCostLabel(technologies.metallurgy.cost)})
        </button>
        <button
          disabled={
            Boolean(player.research.activeTechnology) ||
            !player.research.unlocked.metallurgy ||
            player.research.unlocked['territorial-charter'] ||
            !canAffordTechnology(technologies['territorial-charter'].cost)
          }
          onClick={() => send({ type: 'research', technologyId: 'territorial-charter' })}
        >
          Research {technologies['territorial-charter'].displayName} (
          {technologyCostLabel(technologies['territorial-charter'].cost)})
        </button>
        <button
          disabled={
            Boolean(player.research.activeTechnology) ||
            !player.research.unlocked.metallurgy ||
            player.research.unlocked.engineering ||
            player.research.unlocked.stewardship ||
            !canAffordTechnology(technologies.engineering.cost)
          }
          onClick={() => send({ type: 'research', technologyId: 'engineering' })}
        >
          Choose {technologies.engineering.displayName} (
          {technologyCostLabel(technologies.engineering.cost)})
        </button>
        <button
          disabled={
            Boolean(player.research.activeTechnology) ||
            !player.research.unlocked.metallurgy ||
            player.research.unlocked.engineering ||
            player.research.unlocked.stewardship ||
            !canAffordTechnology(technologies.stewardship.cost)
          }
          onClick={() => send({ type: 'research', technologyId: 'stewardship' })}
        >
          Choose {technologies.stewardship.displayName} (
          {technologyCostLabel(technologies.stewardship.cost)})
        </button>
        <section className="information-browser" aria-labelledby="information-browser-title">
          <h2 id="information-browser-title">Settlement information</h2>
          <p>
            Search construction, recipes, inventories, population, research, defense, and current
            alerts.
          </p>
          <div className="information-search-controls">
            <label htmlFor="information-category">
              Category
              <select
                id="information-category"
                value={informationCategory}
                onChange={(event) =>
                  setInformationCategory(event.target.value as InformationCategory | 'all')
                }
              >
                <option value="all">All information</option>
                {informationCategories.map((category) => (
                  <option key={category} value={category}>
                    {category[0]?.toLocaleUpperCase()}
                    {category.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="information-query">
              Search
              <input
                id="information-query"
                type="search"
                value={informationQuery}
                onChange={(event) => setInformationQuery(event.target.value)}
                placeholder="Try wood, smelter, jobs, raider…"
              />
            </label>
          </div>
          <p aria-live="polite">
            {informationResults.length} result
            {informationResults.length === 1 ? '' : 's'}
          </p>
          {informationResults.length > 0 ? (
            <ul className="information-results">
              {informationResults.map((entry) => (
                <li key={entry.id}>
                  <span className={`information-category ${entry.category}`}>{entry.category}</span>
                  <strong>{entry.title}</strong>
                  <span>{entry.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No settlement information matches this search.</p>
          )}
        </section>
      </>
    )}
  </div>
);
