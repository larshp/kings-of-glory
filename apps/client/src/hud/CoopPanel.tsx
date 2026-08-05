import type { Dispatch, SetStateAction } from 'react';
import type { cooperativeObjectives as cooperativeObjectiveDefinitions } from '@kings/content';
import type { ClientWorldState, DirectoryEntry } from '@kings/protocol';
import { itemLabel, ITEM_KINDS } from './labels.js';
import type { ItemKind, PlayerView, SendCommand, TabPanelProps, Tile } from './types.js';

type Settlement = ClientWorldState['settlements'][string];

export interface DirectoryView {
  entries: DirectoryEntry[];
  nextCursor?: string;
}

export interface CoopPanelProps extends TabPanelProps {
  readonly state: ClientWorldState | undefined;
  readonly player: PlayerView | undefined;
  readonly playerId: string;
  readonly selectedTile: Tile | undefined;
  readonly settlements: readonly Settlement[];
  readonly ownedSettlements: readonly Settlement[];
  readonly personalSettlement: Settlement | undefined;
  readonly sharedProjects: readonly ClientWorldState['sharedConstructionProjects'][string][];
  readonly frontierBeacon: ClientWorldState['cooperativeObjectives']['frontier-beacon'] | undefined;
  readonly frontierBeaconDefinition: (typeof cooperativeObjectiveDefinitions)['frontier-beacon'];
  readonly transfers: ClientWorldState['transfers'];
  readonly chatMessages: ClientWorldState['social']['messages'];
  readonly chatText: string;
  readonly setChatText: Dispatch<SetStateAction<string>>;
  readonly chatSettlementId: string;
  readonly setChatSettlementId: Dispatch<SetStateAction<string>>;
  readonly blockedPlayerIds: readonly string[];
  readonly directory: DirectoryView | undefined;
  readonly directoryQuery: string;
  readonly setDirectoryQuery: Dispatch<SetStateAction<string>>;
  readonly requestDirectory: (after?: string) => void;
  readonly inviteeId: string;
  readonly setInviteeId: Dispatch<SetStateAction<string>>;
  readonly recipientId: string;
  readonly setRecipientId: Dispatch<SetStateAction<string>>;
  readonly recipientItem: ItemKind;
  readonly setRecipientItem: Dispatch<SetStateAction<ItemKind>>;
  readonly playerNameDraft: string;
  readonly setPlayerNameDraft: Dispatch<SetStateAction<string>>;
  readonly settlementNameDraft: string;
  readonly setSettlementNameDraft: Dispatch<SetStateAction<string>>;
  readonly accountDeletionConfirmation: string;
  readonly setAccountDeletionConfirmation: Dispatch<SetStateAction<string>>;
  readonly send: SendCommand;
}

/** Everything social: settlements, shared projects, trade, chat, and the directory. */
export const CoopPanel = ({
  hidden,
  state,
  player,
  playerId,
  selectedTile,
  settlements,
  ownedSettlements,
  personalSettlement,
  sharedProjects,
  frontierBeacon,
  frontierBeaconDefinition,
  transfers,
  chatMessages,
  chatText,
  setChatText,
  chatSettlementId,
  setChatSettlementId,
  blockedPlayerIds,
  directory,
  directoryQuery,
  setDirectoryQuery,
  requestDirectory,
  inviteeId,
  setInviteeId,
  recipientId,
  setRecipientId,
  recipientItem,
  setRecipientItem,
  playerNameDraft,
  setPlayerNameDraft,
  settlementNameDraft,
  setSettlementNameDraft,
  accountDeletionConfirmation,
  setAccountDeletionConfirmation,
  send,
}: CoopPanelProps) => (
  <div
    aria-labelledby="hud-tab-coop"
    className="hud-panel"
    hidden={hidden}
    id="hud-panel-coop"
    role="tabpanel"
    tabIndex={0}
  >
    {player && (
      <>
        <h2>Cooperation</h2>
        {frontierBeacon && personalSettlement && (
          <section className="global-objective" aria-labelledby="frontier-beacon-title">
            <h3 id="frontier-beacon-title">{frontierBeaconDefinition.displayName}</h3>
            <p>{frontierBeaconDefinition.description}</p>
            <p>
              Shared progress: {frontierBeacon.totalContributed}/
              {frontierBeaconDefinition.targetAmount} tools. Your contribution:{' '}
              {frontierBeacon.contributionsByPlayer[playerId] ?? 0}.
            </p>
            {frontierBeacon.completedTick === null ? (
              <button
                disabled={
                  player.inventory.tool < 1 ||
                  frontierBeacon.totalContributed >= frontierBeaconDefinition.targetAmount
                }
                onClick={() =>
                  send(
                    {
                      type: 'contributeToObjective',
                      objectiveId: 'frontier-beacon',
                      settlementId: personalSettlement.id,
                      amount: 1,
                    },
                    'Contributed one tool to the Frontier Beacon.',
                  )
                }
              >
                Contribute 1 tool
              </button>
            ) : (
              <>
                <p>Completed at tick {frontierBeacon.completedTick}.</p>
                <button
                  disabled={
                    !frontierBeacon.contributionsByPlayer[playerId] ||
                    Boolean(frontierBeacon.rewardClaims[playerId])
                  }
                  onClick={() =>
                    send(
                      { type: 'claimObjectiveReward', objectiveId: 'frontier-beacon' },
                      'Claimed the Frontier Beacon reward.',
                    )
                  }
                >
                  {frontierBeacon.rewardClaims[playerId]
                    ? 'Reward claimed'
                    : 'Claim reward: 2 ingots'}
                </button>
              </>
            )}
          </section>
        )}
        <section className="identity-panel" aria-labelledby="identity-title">
          <h3 id="identity-title">Names</h3>
          <p>
            Playing as {state?.social.playerNames[playerId] ?? playerId}. Names are normalized,
            unique, length-limited, and checked by server moderation rules.
          </p>
          <label htmlFor="player-name">Player display name</label>
          <input
            id="player-name"
            value={playerNameDraft}
            maxLength={24}
            onChange={(event) => setPlayerNameDraft(event.target.value)}
            placeholder={state?.social.playerNames[playerId] ?? 'Settler'}
          />
          <button
            disabled={!playerNameDraft.trim()}
            onClick={() => {
              send({ type: 'setPlayerName', name: playerNameDraft }, 'Updated your player name.');
              setPlayerNameDraft('');
            }}
          >
            Update player name
          </button>
          <details className="account-deletion">
            <summary>Delete account</summary>
            <p>
              This permanently removes your private player state, buildings, scouts, land, and
              memberships. Moderation and transaction ledgers retain server-side integrity records
              with your display name removed. This player identity cannot be reused.
            </p>
            {ownedSettlements.length > 0 && (
              <p>Transfer ownership of every settlement before deleting this account.</p>
            )}
            <label htmlFor="account-deletion-confirmation">Type DELETE to confirm</label>
            <input
              id="account-deletion-confirmation"
              value={accountDeletionConfirmation}
              maxLength={16}
              autoComplete="off"
              onChange={(event) => setAccountDeletionConfirmation(event.target.value)}
            />
            <button
              className="danger-button"
              disabled={ownedSettlements.length > 0 || accountDeletionConfirmation !== 'DELETE'}
              onClick={() =>
                send(
                  { type: 'deleteAccount', confirmation: accountDeletionConfirmation },
                  undefined,
                  () => {
                    sessionStorage.removeItem('kings-dev-player-id');
                    window.location.reload();
                  },
                )
              }
            >
              Permanently delete account
            </button>
          </details>
        </section>
        <section className="chat-panel" aria-labelledby="chat-title">
          <h3 id="chat-title">Cooperation chat</h3>
          <label htmlFor="chat-channel">Channel</label>
          <select
            id="chat-channel"
            value={chatSettlementId}
            onChange={(event) => setChatSettlementId(event.target.value)}
          >
            <option value="global">Global</option>
            {settlements
              .filter((settlement) => settlement.members[playerId])
              .map((settlement) => (
                <option key={settlement.id} value={settlement.id}>
                  {state?.social.settlementNames[settlement.id] ?? settlement.id}
                </option>
              ))}
          </select>
          <label htmlFor="chat-message">Message</label>
          <textarea
            id="chat-message"
            value={chatText}
            maxLength={280}
            onChange={(event) => setChatText(event.target.value)}
            placeholder="Coordinate with other settlements"
          />
          <button
            disabled={!chatText.trim()}
            onClick={() => {
              send(
                chatSettlementId === 'global'
                  ? { type: 'sendChatMessage', channel: 'global', text: chatText }
                  : {
                      type: 'sendChatMessage',
                      channel: 'settlement',
                      settlementId: chatSettlementId,
                      text: chatText,
                    },
                'Message sent.',
              );
              setChatText('');
            }}
          >
            Send message
          </button>
          <ul className="chat-messages" aria-live="polite">
            {chatMessages.slice(-30).map((message) => (
              <li key={message.id}>
                <strong>{message.senderName}</strong> [{message.channel}] {message.text}
                {message.senderId !== playerId && (
                  <span className="chat-controls">
                    <button
                      onClick={() =>
                        send({
                          type: 'setPlayerBlocked',
                          targetPlayerId: message.senderId,
                          blocked: true,
                        })
                      }
                    >
                      Block
                    </button>
                    <button
                      onClick={() =>
                        send(
                          {
                            type: 'reportChatMessage',
                            messageId: message.id,
                            reason: 'Inappropriate or abusive message',
                          },
                          'Message reported for moderator review.',
                        )
                      }
                    >
                      Report
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {blockedPlayerIds.length > 0 && (
            <p>
              Blocked:{' '}
              {blockedPlayerIds.map((blockedId) => (
                <button
                  key={blockedId}
                  onClick={() =>
                    send({
                      type: 'setPlayerBlocked',
                      targetPlayerId: blockedId,
                      blocked: false,
                    })
                  }
                >
                  Unblock {state?.social.playerNames[blockedId] ?? blockedId}
                </button>
              ))}
            </p>
          )}
        </section>
        <section className="player-directory" aria-labelledby="directory-title">
          <h3 id="directory-title">World directory</h3>
          <p>Search public player and settlement identifiers without revealing map state.</p>
          <label htmlFor="directory-query">Player or settlement</label>
          <input
            id="directory-query"
            value={directoryQuery}
            maxLength={32}
            onChange={(event) => setDirectoryQuery(event.target.value)}
            placeholder="Search the world"
          />
          <button onClick={() => requestDirectory()}>Search directory</button>
          {directory && (
            <ul className="directory-results">
              {directory.entries.map((entry) =>
                entry.type === 'player' ? (
                  <li key={`player:${entry.playerId}`}>
                    Player {entry.displayName} ({entry.playerId}){' '}
                    <button onClick={() => setRecipientId(entry.playerId)}>Send resources</button>{' '}
                    <button onClick={() => setInviteeId(entry.playerId)}>Invite</button>
                  </li>
                ) : (
                  <li key={`settlement:${entry.settlementId}`}>
                    {entry.displayName} ({entry.settlementId}) — owner {entry.ownerId},{' '}
                    {entry.memberCount} member
                    {entry.memberCount === 1 ? '' : 's'}
                  </li>
                ),
              )}
            </ul>
          )}
          {directory?.nextCursor && (
            <button onClick={() => requestDirectory(directory.nextCursor)}>More results</button>
          )}
        </section>
        <label htmlFor="recipient-id">Recipient player ID</label>
        <input
          id="recipient-id"
          value={recipientId}
          onChange={(event) => setRecipientId(event.target.value)}
          placeholder="dev-…"
        />
        <label htmlFor="recipient-item">Resource to send</label>
        <select
          id="recipient-item"
          value={recipientItem}
          onChange={(event) => setRecipientItem(event.target.value as ItemKind)}
        >
          {ITEM_KINDS.map((item) => (
            <option key={item} value={item}>
              {itemLabel(item)}
            </option>
          ))}
        </select>
        <button
          disabled={!recipientId.trim() || player.inventory[recipientItem] < 1}
          onClick={() =>
            send({
              type: 'transferToPlayer',
              targetPlayerId: recipientId.trim(),
              item: recipientItem,
              amount: 1,
            })
          }
        >
          Send 1 {recipientItem}
        </button>
        <section className="settlement-panel" aria-labelledby="settlement-title">
          <h2 id="settlement-title">Settlement roles</h2>
          <p>Owners invite members. Builders maintain production; logistics members move items.</p>
          <label htmlFor="invitee-id">Invite player ID</label>
          <input
            id="invitee-id"
            value={inviteeId}
            onChange={(event) => setInviteeId(event.target.value)}
            placeholder="dev-player"
          />
          <button
            disabled={!personalSettlement || !inviteeId.trim()}
            onClick={() =>
              personalSettlement &&
              send({
                type: 'inviteToSettlement',
                settlementId: personalSettlement.id,
                targetPlayerId: inviteeId.trim(),
              })
            }
          >
            Invite to my settlement
          </button>
          {settlements.map((settlement) => {
            const role = settlement.members[playerId];
            const invited = settlement.invitations[playerId];
            const projects = sharedProjects.filter(
              (project) => project.settlementId === settlement.id,
            );
            return (
              <section className="settlement" key={settlement.id}>
                <strong>{state?.social.settlementNames[settlement.id] ?? settlement.id}</strong>
                {invited && !role && (
                  <button
                    onClick={() =>
                      send({ type: 'acceptSettlementInvite', settlementId: settlement.id })
                    }
                  >
                    Accept invitation
                  </button>
                )}
                {role && (
                  <>
                    <span>Your role: {role}</span>
                    {role === 'owner' && (
                      <>
                        <label htmlFor={`settlement-name-${settlement.id}`}>Settlement name</label>
                        <input
                          id={`settlement-name-${settlement.id}`}
                          value={settlementNameDraft}
                          maxLength={32}
                          onChange={(event) => setSettlementNameDraft(event.target.value)}
                          placeholder={
                            state?.social.settlementNames[settlement.id] ?? settlement.id
                          }
                        />
                        <button
                          disabled={!settlementNameDraft.trim()}
                          onClick={() => {
                            send(
                              {
                                type: 'setSettlementName',
                                settlementId: settlement.id,
                                name: settlementNameDraft,
                              },
                              'Updated the settlement name.',
                            );
                            setSettlementNameDraft('');
                          }}
                        >
                          Update settlement name
                        </button>
                      </>
                    )}
                    {role !== 'owner' && (
                      <button
                        onClick={() =>
                          send({ type: 'leaveSettlement', settlementId: settlement.id })
                        }
                      >
                        Leave settlement
                      </button>
                    )}
                    <ul className="member-list">
                      {Object.entries(settlement.members).map(([memberId, memberRole]) => (
                        <li key={memberId}>
                          {state?.social.playerNames[memberId] ?? memberId}: {memberRole}
                          {role === 'owner' && memberId !== playerId && (
                            <span className="role-controls">
                              <button
                                onClick={() =>
                                  send({
                                    type: 'setSettlementRole',
                                    settlementId: settlement.id,
                                    targetPlayerId: memberId,
                                    role: 'builder',
                                  })
                                }
                              >
                                Builder
                              </button>
                              <button
                                onClick={() =>
                                  send({
                                    type: 'setSettlementRole',
                                    settlementId: settlement.id,
                                    targetPlayerId: memberId,
                                    role: 'logistics',
                                  })
                                }
                              >
                                Logistics
                              </button>
                              <button
                                onClick={() =>
                                  send({
                                    type: 'setSettlementRole',
                                    settlementId: settlement.id,
                                    targetPlayerId: memberId,
                                    role: 'member',
                                  })
                                }
                              >
                                Member
                              </button>
                              <button
                                onClick={() =>
                                  send({
                                    type: 'transferSettlementOwnership',
                                    settlementId: settlement.id,
                                    targetPlayerId: memberId,
                                  })
                                }
                              >
                                Transfer ownership
                              </button>
                              <button
                                onClick={() =>
                                  send({
                                    type: 'removeSettlementMember',
                                    settlementId: settlement.id,
                                    targetPlayerId: memberId,
                                  })
                                }
                              >
                                Remove member
                              </button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {(role === 'owner' || role === 'builder') && (
                      <button
                        disabled={!selectedTile}
                        onClick={() =>
                          selectedTile &&
                          send(
                            {
                              type: 'createSharedConstructionProject',
                              settlementId: settlement.id,
                              buildingKind: 'storage',
                              ...selectedTile,
                            },
                            'Created a shared storage construction project.',
                          )
                        }
                      >
                        Start shared storage at selected tile
                      </button>
                    )}
                    {projects.length > 0 && (
                      <ul className="project-list">
                        {projects.map((project) => {
                          const item = (['wood', 'ore', 'ingot', 'tool'] as const).find(
                            (candidate) =>
                              project.contributed[candidate] < project.required[candidate],
                          );
                          const remaining = item
                            ? project.required[item] - project.contributed[item]
                            : 0;
                          return (
                            <li key={project.id}>
                              {project.buildingKind} at {project.x}, {project.y}:{' '}
                              {project.completedTick === null
                                ? `${project.contributed.wood}/${project.required.wood} wood funded`
                                : `completed at tick ${project.completedTick}`}
                              {project.completedTick === null && item && (
                                <button
                                  disabled={player.inventory[item] < 1 || remaining < 1}
                                  onClick={() =>
                                    send(
                                      {
                                        type: 'contributeToSharedConstructionProject',
                                        projectId: project.id,
                                        item,
                                        amount: 1,
                                      },
                                      `Contributed one ${item} to the shared project.`,
                                    )
                                  }
                                >
                                  Contribute 1 {item}
                                </button>
                              )}
                              {project.contributionHistory.length > 0 && (
                                <small>
                                  {' '}
                                  Recent:{' '}
                                  {project.contributionHistory
                                    .slice(-3)
                                    .map(
                                      (contribution) =>
                                        `${contribution.playerId} +${contribution.amount} ${contribution.item}`,
                                    )
                                    .join(', ')}
                                </small>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                )}
              </section>
            );
          })}
        </section>
        {transfers.length > 0 && (
          <section aria-labelledby="transfer-history-title">
            <h2 id="transfer-history-title">Recent transfers</h2>
            <ul className="transfer-history">
              {transfers.slice(-5).map((transfer) => (
                <li key={transfer.id}>
                  {transfer.fromPlayerId === playerId ? 'Sent' : 'Received'} {transfer.amount}{' '}
                  {transfer.item} {transfer.fromPlayerId === playerId ? 'to' : 'from'}{' '}
                  {transfer.fromPlayerId === playerId ? transfer.toPlayerId : transfer.fromPlayerId}
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    )}
  </div>
);
