import type { Dispatch, SetStateAction } from 'react';
import type { ClientWorldState } from '@kings/protocol';
import type { Plot } from '@kings/simulation';
import {
  informationCategories,
  type InformationCategory,
  type InformationEntry,
} from '../information-search.js';
import type { Notice, NotificationSeverity } from '../notifications.js';
import type { ResearchEntry } from './research.js';
import type { PlayerView, SendCommand, TabPanelProps } from './types.js';

type AlertEntry = InformationEntry & { readonly severity: NotificationSeverity };

/**
 * The badge on a technology. A technology that is only unaffordable is not locked, and
 * saying so would send the player looking for a prerequisite that is already met.
 */
const researchStateLabel = (entry: ResearchEntry) =>
  entry.state === 'unlocked'
    ? 'Unlocked'
    : entry.state === 'researching'
      ? `${entry.ticksRemaining} ticks remaining`
      : entry.state === 'available'
        ? 'Available'
        : entry.blockedBy === 'cost'
          ? 'Not affordable'
          : entry.blockedBy === 'research-in-progress'
            ? 'Waiting'
            : entry.blockedBy === 'path-closed'
              ? 'Closed'
              : 'Locked';

export interface SettlementPanelProps extends TabPanelProps {
  readonly player: PlayerView | undefined;
  readonly plot: Plot | undefined;
  readonly progressionEra: string;
  readonly onboardingSteps: readonly { readonly complete: boolean; readonly text: string }[];
  readonly onboardingReservation: ClientWorldState['onboardingReservations'][string] | undefined;
  readonly hasCompletedHearth: boolean;
  readonly exploredChunkCount: number;
  readonly visibleChunkCount: number;
  /** Generated from the content graph, so the panel never re-encodes prerequisites. */
  readonly researchEntries: readonly ResearchEntry[];
  readonly messageLog: readonly Notice[];
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
  researchEntries,
  messageLog,
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
          {/* Toasts fade, so the messages they carried stay reviewable here. */}
          <details className="message-log">
            <summary>Recent messages ({messageLog.length})</summary>
            {messageLog.length === 0 ? (
              <p>No messages yet.</p>
            ) : (
              <ul>
                {[...messageLog].reverse().map((message) => (
                  <li className={message.severity} key={message.id}>
                    {message.text}
                    {message.count > 1 ? ` ×${message.count}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </details>
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
          <li className={player.research.unlocked.masonry ? 'complete' : undefined}>
            Masonry: quarry stone from the ranges, fire it into brick, then raise walls and upgrade
            buildings to their second tier.
          </li>
          <li
            className={
              player.research.unlocked.engineering || player.research.unlocked.stewardship
                ? 'complete'
                : undefined
            }
          >
            Development: choose Engineering for faster carriers and roads, or Stewardship for
            renewable timber. This choice is permanent.
          </li>
        </ol>
        <section aria-labelledby="research-title" className="research-tree">
          <h2 id="research-title">Research</h2>
          <p>
            Each technology states its cost, what it needs first, and what it unlocks. One
            technology is researched at a time.
          </p>
          <ul>
            {researchEntries.map((entry) => (
              <li
                className={`research-entry ${entry.state}`}
                data-depth={entry.depth}
                key={entry.id}
                style={{ marginInlineStart: `${entry.depth * 0.75}rem` }}
              >
                <span className="research-heading">
                  <strong>{entry.name}</strong>
                  <span className={`research-state ${entry.state}`}>
                    {researchStateLabel(entry)}
                  </span>
                </span>
                <span className="research-detail">
                  {entry.costLabel} · {entry.ticks} ticks
                  {entry.prerequisiteNames.length > 0
                    ? ` · after ${entry.prerequisiteNames.join(' and ')}`
                    : ''}
                </span>
                {entry.unlocks.length > 0 && (
                  <span className="research-detail">Unlocks {entry.unlocks.join(', ')}.</span>
                )}
                {entry.permanentChoice && (
                  <span className="research-permanent">{entry.permanentChoice}</span>
                )}
                {entry.state !== 'unlocked' && entry.state !== 'researching' && (
                  <button
                    className="block-button"
                    disabled={entry.state !== 'available'}
                    onClick={() => send({ type: 'research', technologyId: entry.id })}
                  >
                    Research {entry.name} ({entry.costLabel})
                  </button>
                )}
                {entry.blockedReason && <span className="build-reason">{entry.blockedReason}</span>}
              </li>
            ))}
          </ul>
        </section>
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
