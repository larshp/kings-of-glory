import {
  PROTOCOL_VERSION,
  type ClientWorldDelta,
  type ClientWorldState,
  type ServerMessage,
  type TerrainTile,
} from '@kings/protocol';
import {
  advanceTick,
  applyCommand,
  createWorld,
  chunkKeyFor,
  CHUNK_SIZE,
  deserializeWorld,
  diffWorld,
  emptyInventory,
  joinPlayer,
  snapshot,
  elevationAt,
  terrainAt,
  tileKey,
  TICK_PIPELINE,
  type TickPhase,
  type WorldState,
} from '@kings/simulation';
import { MemoryWorldPersistence, type WorldPersistence } from './persistence.js';
import {
  applyAdministrativeMutation,
  inspectAdministrativeWorld,
  type AdministrativeInspectionRequest,
  type AdministrativeMutationInput,
} from './admin.js';
import { directoryPageFor, worldMapPageFor } from './queries.js';

export interface Connection {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Expands chunk keys into their tiles and records what the client is allowed to see of
 * each one. Terrain is filled only when `terrain` is given: between deltas a client's
 * terrain map is usually carried forward unchanged, while elevation is always rewritten.
 */
const fillChunkTiles = (
  seed: number,
  chunks: Iterable<string>,
  terrain: Record<string, TerrainTile> | undefined,
  elevation: Record<string, number>,
) => {
  for (const chunk of chunks) {
    const [chunkX, chunkY] = chunk.split(':').map(Number);
    for (let localX = 0; localX < CHUNK_SIZE; localX += 1)
      for (let localY = 0; localY < CHUNK_SIZE; localY += 1) {
        const x = chunkX! * CHUNK_SIZE + localX;
        const y = chunkY! * CHUNK_SIZE + localY;
        const key = tileKey(x, y);
        if (terrain) terrain[key] = terrainAt(seed, x, y);
        elevation[key] = elevationAt(seed, x, y);
      }
  }
};

/** Claimed sectors, flattened to the owner each one belongs to. */
const territoryBySector = (players: WorldState['players']): Record<string, string> =>
  Object.fromEntries(
    Object.values(players).flatMap((owner) =>
      Object.keys(owner.territoryCells).map((sector) => [sector, owner.id]),
    ),
  );

export interface WorldHostMetrics {
  readonly acceptedCommands: number;
  readonly rejectedCommands: number;
  readonly persistenceFailures: number;
  readonly lastCommandDurationMs: number;
  readonly checkpointFailures: number;
  readonly lastCheckpointDurationMs: number;
  readonly lastCheckpointTick: number;
  readonly lastRecoveryDurationMs: number;
  readonly fullStateMessages: number;
  readonly fullStateBytes: number;
  readonly deltaStateMessages: number;
  readonly deltaStateBytes: number;
  readonly lastStateBuildDurationMs: number;
  readonly tickPhaseDurationsMs: Readonly<Record<TickPhase, number>>;
  readonly pathQueueLength: number;
}

const deltaFrom = (previous: ClientWorldState, next: ClientWorldState): ClientWorldDelta => {
  const delta: ClientWorldDelta = {};
  for (const key of Object.keys(next) as Array<keyof ClientWorldState>)
    if (previous[key] !== next[key] && JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
      Object.assign(delta, { [key]: next[key] });
  return delta;
};

export class GlobalWorldHost {
  #world: WorldState;
  #checkpointBaseline: WorldState;
  #connections = new Map<Connection, { playerId: string; visibleChunks?: Set<string> }>();
  #clientStates = new Map<Connection, { version: number; state: ClientWorldState }>();
  #stateFingerprints = new WeakMap<ClientWorldState, Map<keyof ClientWorldState, string>>();
  #version = 0;
  #checkpointInProgress = false;
  #acceptedCommands = 0;
  #rejectedCommands = 0;
  #persistenceFailures = 0;
  #lastCommandDurationMs = 0;
  #checkpointFailures = 0;
  #lastCheckpointDurationMs = 0;
  #lastCheckpointTick = 0;
  #lastRecoveryDurationMs = 0;
  #fullStateMessages = 0;
  #fullStateBytes = 0;
  #deltaStateMessages = 0;
  #deltaStateBytes = 0;
  #lastStateBuildDurationMs = 0;
  #viewIndex:
    | {
        version: number;
        world: WorldState;
        buildingsByOwner: Map<
          string,
          Array<{ id: string; building: WorldState['buildings'][string]; order: number }>
        >;
        buildingsByChunk: Map<
          string,
          Array<{ id: string; building: WorldState['buildings'][string]; order: number }>
        >;
      }
    | undefined;
  #tickPhaseDurationsMs = Object.fromEntries(TICK_PIPELINE.map((phase) => [phase, 0])) as Record<
    TickPhase,
    number
  >;
  // Serializes every mutation of #world. Commands snapshot the world, await
  // persistence, then commit the snapshot back; without a queue, commands (and
  // ticks) that overlap that await would each start from the same pre-commit
  // world and clobber one another, silently dropping accepted commands.
  #worldQueue: Promise<void> = Promise.resolve();

  constructor(
    seed = 1,
    private readonly persistence: WorldPersistence = new MemoryWorldPersistence(),
    private readonly checkpointIntervalTicks = 300,
    peaceful = true,
  ) {
    this.#world = createWorld(seed, peaceful);
    this.#checkpointBaseline = snapshot(this.#world);
  }

  get world(): WorldState {
    return this.#world;
  }
  get connectedPlayerCount(): number {
    return this.#connections.size;
  }
  get metrics(): WorldHostMetrics {
    return {
      acceptedCommands: this.#acceptedCommands,
      rejectedCommands: this.#rejectedCommands,
      persistenceFailures: this.#persistenceFailures,
      lastCommandDurationMs: this.#lastCommandDurationMs,
      checkpointFailures: this.#checkpointFailures,
      lastCheckpointDurationMs: this.#lastCheckpointDurationMs,
      lastCheckpointTick: this.#lastCheckpointTick,
      lastRecoveryDurationMs: this.#lastRecoveryDurationMs,
      fullStateMessages: this.#fullStateMessages,
      fullStateBytes: this.#fullStateBytes,
      deltaStateMessages: this.#deltaStateMessages,
      deltaStateBytes: this.#deltaStateBytes,
      lastStateBuildDurationMs: this.#lastStateBuildDurationMs,
      tickPhaseDurationsMs: { ...this.#tickPhaseDurationsMs },
      pathQueueLength: Object.keys(this.#world.threats).length,
    };
  }

  async restore(options: { migrate?: boolean } = {}): Promise<void> {
    const startedAt = performance.now();
    try {
      if (options.migrate ?? true) await this.persistence.migrate();
      const checkpoint = await this.persistence.loadLatestCheckpoint();
      if (!checkpoint) return;
      this.#world = deserializeWorld(checkpoint.state);
      this.#checkpointBaseline = snapshot(this.#world);
      this.#lastCheckpointTick = checkpoint.tick;
      for (const entry of await this.persistence.loadJournalAfter(this.#world.tick)) {
        while (this.#world.tick < entry.targetTick) advanceTick(this.#world);
        applyCommand(this.#world, entry.command);
      }
    } finally {
      this.#lastRecoveryDurationMs = performance.now() - startedAt;
    }
  }

  async connect(connection: Connection, playerId: string): Promise<void> {
    await this.serialize(async () => {
      const candidate = snapshot(this.#world);
      const joined = joinPlayer(candidate, playerId);
      if (joined.length > 0) await this.saveCheckpoint(candidate);
      this.#world = candidate;
    });
    this.#connections.set(connection, { playerId });
    this.send(connection, {
      type: 'welcome',
      version: PROTOCOL_VERSION,
      playerId,
    });
    this.sendBootstrap(connection, playerId);
    this.broadcastState();
  }

  disconnect(connection: Connection): void {
    this.#connections.delete(connection);
    this.#clientStates.delete(connection);
  }

  resync(connection: Connection): void {
    const playerId = this.#connections.get(connection)?.playerId;
    if (!playerId) return;
    this.sendBootstrap(connection, playerId);
  }

  worldMap(
    connection: Connection,
    requestId: string,
    after: string | undefined,
    limit: number,
  ): void {
    const playerId = this.#connections.get(connection)?.playerId;
    if (!playerId) return;
    this.send(connection, {
      type: 'worldMapPage',
      requestId,
      page: worldMapPageFor(this.#world, playerId, after, limit),
    });
  }

  directory(
    connection: Connection,
    requestId: string,
    query: string,
    after: string | undefined,
    limit: number,
  ): void {
    if (!this.#connections.has(connection)) return;
    this.send(connection, {
      type: 'directoryPage',
      requestId,
      page: directoryPageFor(this.#world, query, after, limit),
    });
  }

  inspectAdministrative(request: AdministrativeInspectionRequest): unknown {
    return inspectAdministrativeWorld(snapshot(this.#world), request);
  }

  administrativeAuditEvents(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Administrative audit limit must be between 1 and 500');
    return this.persistence.loadAdministrativeAuditEvents(limit);
  }

  mutateAdministrative(input: AdministrativeMutationInput) {
    return this.serialize(async () => {
      const { state, audit } = applyAdministrativeMutation(this.#world, input);
      const startedAt = performance.now();
      try {
        await this.persistence.commitAdministrativeMutation(state, audit);
        this.#world = state;
        this.#checkpointBaseline = snapshot(state);
        this.#lastCheckpointTick = state.tick;
        this.broadcastState();
        return audit;
      } catch (error) {
        this.#checkpointFailures += 1;
        throw error;
      } finally {
        this.#lastCheckpointDurationMs = performance.now() - startedAt;
      }
    });
  }

  /** Replaces the viewport chunks a client is observing and immediately snapshots new chunks. */
  setInterest(connection: Connection, chunks: readonly { x: number; y: number }[]): void {
    const connectionState = this.#connections.get(connection);
    if (!connectionState) return;
    // Interest arrives in chunk coordinates, so key it off that chunk's origin tile.
    const keyFor = (chunk: { x: number; y: number }) =>
      chunkKeyFor(chunk.x * CHUNK_SIZE, chunk.y * CHUNK_SIZE);
    const visibleChunks = new Set(chunks.map(keyFor));
    const addedChunks = chunks.filter(
      (chunk) => !connectionState.visibleChunks?.has(keyFor(chunk)),
    );
    connectionState.visibleChunks = visibleChunks;
    // Interest snapshots may be requested between broadcasts, after administrative
    // or test-time world changes that do not advance the state version.
    this.#viewIndex = undefined;
    if (addedChunks.length > 0)
      this.sendChunkSnapshot(connection, connectionState.playerId, addedChunks);
  }

  /** Runs world mutations one at a time so overlapping awaits cannot clobber #world. */
  private serialize<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.#worldQueue.then(() => task());
    // Keep the chain alive (and unrejected) so one failed task cannot wedge the rest.
    this.#worldQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  command(connection: Connection, command: Parameters<typeof applyCommand>[1]): Promise<void> {
    return this.serialize(() => this.runCommand(connection, command));
  }

  private async runCommand(
    connection: Connection,
    command: Parameters<typeof applyCommand>[1],
  ): Promise<void> {
    const startedAt = performance.now();
    const playerId = this.#connections.get(connection)?.playerId;
    try {
      if (!playerId || playerId !== command.playerId) {
        this.#rejectedCommands += 1;
        this.send(connection, {
          type: 'commandRejected',
          result: { accepted: false, commandId: command.id, code: 'unauthorized' },
        });
        return;
      }
      const candidate = snapshot(this.#world);
      const outcome = applyCommand(candidate, command);
      if (outcome.result.accepted) {
        try {
          await this.persistence.appendAcceptedCommand({ command, targetTick: candidate.tick });
        } catch {
          this.#persistenceFailures += 1;
          this.#rejectedCommands += 1;
          this.send(connection, {
            type: 'commandRejected',
            result: { accepted: false, commandId: command.id, code: 'persistence-failed' },
          });
          return;
        }
        this.#world = candidate;
        this.#acceptedCommands += 1;
      } else {
        this.#rejectedCommands += 1;
      }
      this.send(
        connection,
        outcome.result.accepted
          ? { type: 'commandAcknowledged', result: outcome.result }
          : { type: 'commandRejected', result: outcome.result },
      );
      if (outcome.result.accepted) this.broadcastState();
    } finally {
      this.#lastCommandDurationMs = performance.now() - startedAt;
    }
  }

  async tick(): Promise<void> {
    await this.serialize(() => {
      advanceTick(this.#world, {
        now: () => performance.now(),
        record: (phase, durationMs) => {
          this.#tickPhaseDurationsMs[phase] = durationMs;
        },
      });
      this.broadcastState();
    });
    if (this.#world.tick % this.checkpointIntervalTicks === 0 && !this.#checkpointInProgress) {
      this.#checkpointInProgress = true;
      try {
        await this.saveCheckpoint();
      } finally {
        this.#checkpointInProgress = false;
      }
    }
  }

  async checkpoint(): Promise<void> {
    await this.saveCheckpoint();
  }
  async close(): Promise<void> {
    await this.persistence.close();
  }

  private broadcastState(): void {
    this.#version += 1;
    for (const [connection, { playerId }] of this.#connections)
      this.sendDeltaState(connection, playerId);
  }

  private sendDeltaState(connection: Connection, playerId: string): void {
    const state = this.clientStateFor(connection, playerId);
    const previous = this.#clientStates.get(connection);
    if (!previous || previous.version !== this.#version - 1) {
      this.#clientStates.set(connection, { version: this.#version, state });
      this.sendBootstrap(connection, playerId, state);
      return;
    }
    this.#clientStates.set(connection, { version: this.#version, state });
    this.sendState(connection, {
      type: 'stateDelta',
      version: this.#version,
      baseVersion: previous.version,
      delta: deltaFrom(previous.state, state),
    });
  }

  private sendBootstrap(
    connection: Connection,
    playerId: string,
    state = this.clientStateFor(connection, playerId),
  ): void {
    this.#clientStates.set(connection, { version: this.#version, state });
    this.sendState(connection, {
      type: 'worldBootstrap',
      playerId,
      stateVersion: this.#version,
      state,
    });
  }

  private sendChunkSnapshot(
    connection: Connection,
    playerId: string,
    chunks: readonly { x: number; y: number }[],
  ): void {
    const state = this.clientStateFor(connection, playerId);
    this.#clientStates.set(connection, { version: this.#version, state });
    this.sendState(connection, { type: 'chunkSnapshot', version: this.#version, chunks, state });
  }

  private clientStateFor(connection: Connection, playerId: string): ClientWorldState {
    const startedAt = performance.now();
    try {
      return this.stateFor(
        playerId,
        this.#connections.get(connection)?.visibleChunks,
        this.#clientStates.get(connection)?.state,
      );
    } finally {
      this.#lastStateBuildDurationMs = performance.now() - startedAt;
    }
  }

  private stateFor(
    playerId: string,
    requestedChunks?: ReadonlySet<string>,
    previous?: ClientWorldState,
  ): ClientWorldState {
    const livePlayer = this.#world.players[playerId];
    if (livePlayer) return this.filteredStateFor(playerId, livePlayer, requestedChunks, previous);
    const state = snapshot(this.#world);
    const territory = territoryBySector(state.players);
    const player = state.players[playerId];
    if (!player) {
      state.players = {};
      state.playerActivity = {};
      state.onboardingReservations = {};
      state.processedCommands = [];
      state.minedTiles = {};
      state.transfers = [];
      state.settlements = {};
      state.buildings = {};
      state.threats = {};
      state.scouts = {};
      state.logisticsLinks = {};
      state.carriers = {};
      state.roads = {};
      state.sharedConstructionProjects = {};
      state.cooperativeObjectives = Object.fromEntries(
        Object.entries(state.cooperativeObjectives).map(([id, objective]) => [
          id,
          {
            ...objective,
            contributionsBySettlement: {},
            contributionsByPlayer: {},
            rewardClaims: {},
            contributionHistory: [],
            rewardHistory: [],
          },
        ]),
      ) as unknown as WorldState['cooperativeObjectives'];
      state.social = {
        playerNames: {},
        settlementNames: {},
        blockedPlayers: {},
        lastChatTick: {},
        messages: [],
        reports: [],
      };
      const { seed, randomState, deletedPlayers, ...visibleState } = state;
      void seed;
      void randomState;
      void deletedPlayers;
      return { ...visibleState, terrain: {}, elevation: {}, territory: {} };
    }
    const visibleChunks = requestedChunks ?? new Set(Object.keys(player.exploredChunks));
    const relevantChunks = new Set(
      [...visibleChunks].filter((chunk) => player.exploredChunks[chunk]),
    );
    state.players = { [playerId]: player };
    state.playerActivity = state.playerActivity[playerId]
      ? { [playerId]: state.playerActivity[playerId] }
      : {};
    state.onboardingReservations = state.onboardingReservations[playerId]
      ? { [playerId]: state.onboardingReservations[playerId] }
      : {};
    state.processedCommands = [];
    state.minedTiles = Object.fromEntries(
      Object.entries(state.minedTiles).filter(([tile]) => {
        const [xText, yText] = tile.split(':');
        const x = Number(xText);
        const y = Number(yText);
        return relevantChunks.has(chunkKeyFor(x, y));
      }),
    );
    state.transfers = state.transfers.filter(
      (transfer) => transfer.fromPlayerId === playerId || transfer.toPlayerId === playerId,
    );
    state.settlements = Object.fromEntries(
      Object.entries(state.settlements).filter(
        ([, settlement]) => settlement.members[playerId] || settlement.invitations[playerId],
      ),
    );
    for (const [id, building] of Object.entries(state.buildings)) {
      const chunk = chunkKeyFor(building.x, building.y);
      const sharedRoles = Object.values(state.settlements)
        .filter((settlement) => settlement.members[building.ownerId])
        .map((settlement) => settlement.members[playerId])
        .filter((role): role is 'owner' | 'builder' | 'logistics' | 'member' => Boolean(role));
      const isShared = sharedRoles.length > 0;
      const canViewInventory = sharedRoles.some((role) => role === 'owner' || role === 'logistics');
      if (building.ownerId !== playerId && !isShared && !relevantChunks.has(chunk))
        delete state.buildings[id];
      else if (building.ownerId !== playerId && !canViewInventory)
        building.inventory = emptyInventory();
    }
    for (const [id, threat] of Object.entries(state.threats))
      if (!state.buildings[threat.targetBuildingId]) delete state.threats[id];
    state.scouts = Object.fromEntries(
      Object.entries(state.scouts ?? {}).filter(
        ([, scout]) =>
          scout.ownerId === playerId || relevantChunks.has(chunkKeyFor(scout.x, scout.y)),
      ),
    );
    state.logisticsLinks = Object.fromEntries(
      Object.entries(state.logisticsLinks).filter(
        ([, link]) =>
          state.buildings[link.sourceBuildingId] && state.buildings[link.targetBuildingId],
      ),
    );
    state.carriers = Object.fromEntries(
      Object.entries(state.carriers).filter(
        ([, carrier]) =>
          Boolean(state.logisticsLinks[carrier.linkId]) ||
          relevantChunks.has(chunkKeyFor(carrier.x, carrier.y)),
      ),
    );
    state.roads = Object.fromEntries(
      Object.entries(state.roads).filter(([key]) => {
        const [xText, yText] = key.split(':');
        return relevantChunks.has(chunkKeyFor(Number(xText), Number(yText)));
      }),
    );
    state.cooperativeObjectives = Object.fromEntries(
      Object.entries(state.cooperativeObjectives).map(([id, objective]) => [
        id,
        {
          ...objective,
          contributionsBySettlement: Object.fromEntries(
            Object.entries(objective.contributionsBySettlement).filter(([settlementId]) =>
              Boolean(state.settlements[settlementId]),
            ),
          ),
          contributionsByPlayer: objective.contributionsByPlayer[playerId]
            ? { [playerId]: objective.contributionsByPlayer[playerId] }
            : {},
          rewardClaims: objective.rewardClaims[playerId]
            ? { [playerId]: objective.rewardClaims[playerId] }
            : {},
          contributionHistory: objective.contributionHistory.filter(
            (contribution) => contribution.playerId === playerId,
          ),
          rewardHistory: objective.rewardHistory.filter((reward) => reward.playerId === playerId),
        },
      ]),
    ) as WorldState['cooperativeObjectives'];
    state.sharedConstructionProjects = Object.fromEntries(
      Object.entries(state.sharedConstructionProjects).filter(([, project]) => {
        const settlement = state.settlements[project.settlementId];
        return Boolean(settlement?.members[playerId]);
      }),
    );
    const blocked = state.social.blockedPlayers[playerId] ?? {};
    state.social.messages = state.social.messages.filter((message) => {
      if (blocked[message.senderId]) return false;
      if (message.channel === 'global') return true;
      const settlement = message.settlementId ? state.settlements[message.settlementId] : undefined;
      return Boolean(settlement?.members[playerId]);
    });
    const relevantPlayerNames = new Set<string>([playerId]);
    for (const settlement of Object.values(state.settlements))
      for (const memberId of Object.keys(settlement.members)) relevantPlayerNames.add(memberId);
    for (const message of state.social.messages) relevantPlayerNames.add(message.senderId);
    state.social.playerNames = Object.fromEntries(
      Object.entries(state.social.playerNames).filter(([id]) => relevantPlayerNames.has(id)),
    );
    state.social.settlementNames = Object.fromEntries(
      Object.entries(state.social.settlementNames).filter(([id]) => Boolean(state.settlements[id])),
    );
    state.social.blockedPlayers = { [playerId]: blocked };
    state.social.lastChatTick =
      state.social.lastChatTick[playerId] !== undefined
        ? { [playerId]: state.social.lastChatTick[playerId] }
        : {};
    state.social.reports = [];
    const terrain: Record<string, TerrainTile> = {};
    const elevation: Record<string, number> = {};
    fillChunkTiles(this.#world.seed, relevantChunks, terrain, elevation);
    const { seed, randomState, deletedPlayers, ...visibleState } = state;
    void seed;
    void randomState;
    void deletedPlayers;
    return { ...visibleState, terrain, elevation, territory };
  }

  /** Builds and clones only one player's authorized view instead of cloning the full world. */
  private filteredStateFor(
    playerId: string,
    player: WorldState['players'][string],
    requestedChunks?: ReadonlySet<string>,
    previous?: ClientWorldState,
  ): ClientWorldState {
    const source = this.#world;
    const visibleChunks = requestedChunks ?? new Set(Object.keys(player.exploredChunks));
    const relevantChunks = new Set(
      [...visibleChunks].filter((chunk) => player.exploredChunks[chunk]),
    );
    const settlements = Object.fromEntries(
      Object.entries(source.settlements).filter(
        ([, settlement]) => settlement.members[playerId] || settlement.invitations[playerId],
      ),
    );
    const viewIndex = this.viewIndex();
    const candidateBuildings = new Map<
      string,
      { id: string; building: WorldState['buildings'][string]; order: number }
    >();
    const includeCandidates = (
      candidates: readonly {
        id: string;
        building: WorldState['buildings'][string];
        order: number;
      }[] = [],
    ) => {
      for (const candidate of candidates) candidateBuildings.set(candidate.id, candidate);
    };
    includeCandidates(viewIndex.buildingsByOwner.get(playerId));
    for (const settlement of Object.values(settlements))
      for (const memberId of Object.keys(settlement.members))
        includeCandidates(viewIndex.buildingsByOwner.get(memberId));
    for (const chunk of relevantChunks) includeCandidates(viewIndex.buildingsByChunk.get(chunk));
    const buildings: WorldState['buildings'] = {};
    for (const { id, building } of [...candidateBuildings.values()].sort(
      (left, right) => left.order - right.order,
    )) {
      const sharedRoles = Object.values(settlements)
        .filter((settlement) => settlement.members[building.ownerId])
        .map((settlement) => settlement.members[playerId])
        .filter((role): role is 'owner' | 'builder' | 'logistics' | 'member' => Boolean(role));
      const isShared = sharedRoles.length > 0;
      if (
        building.ownerId !== playerId &&
        !isShared &&
        !relevantChunks.has(chunkKeyFor(building.x, building.y))
      )
        continue;
      const canViewInventory = sharedRoles.some((role) => role === 'owner' || role === 'logistics');
      buildings[id] =
        building.ownerId !== playerId && !canViewInventory
          ? { ...building, inventory: emptyInventory() }
          : building;
    }
    const threats = Object.fromEntries(
      Object.entries(source.threats).filter(([, threat]) => buildings[threat.targetBuildingId]),
    );
    const scouts = Object.fromEntries(
      Object.entries(source.scouts ?? {}).filter(
        ([, scout]) =>
          scout.ownerId === playerId || relevantChunks.has(chunkKeyFor(scout.x, scout.y)),
      ),
    );
    const logisticsLinks = Object.fromEntries(
      Object.entries(source.logisticsLinks).filter(
        ([, link]) => buildings[link.sourceBuildingId] && buildings[link.targetBuildingId],
      ),
    );
    // A carrier is visible with the link it serves, and otherwise as a unit on an
    // observed tile, exactly like a foreign scout walking past.
    const carriers = Object.fromEntries(
      Object.entries(source.carriers).filter(
        ([, carrier]) =>
          Boolean(logisticsLinks[carrier.linkId]) ||
          relevantChunks.has(chunkKeyFor(carrier.x, carrier.y)),
      ),
    );
    const roads = Object.fromEntries(
      Object.entries(source.roads).filter(([key]) => {
        const [xText, yText] = key.split(':');
        return relevantChunks.has(chunkKeyFor(Number(xText), Number(yText)));
      }),
    );
    const cooperativeObjectives = Object.fromEntries(
      Object.entries(source.cooperativeObjectives).map(([id, objective]) => [
        id,
        {
          ...objective,
          contributionsBySettlement: Object.fromEntries(
            Object.entries(objective.contributionsBySettlement).filter(([settlementId]) =>
              Boolean(settlements[settlementId]),
            ),
          ),
          contributionsByPlayer: objective.contributionsByPlayer[playerId]
            ? { [playerId]: objective.contributionsByPlayer[playerId] }
            : {},
          rewardClaims: objective.rewardClaims[playerId]
            ? { [playerId]: objective.rewardClaims[playerId] }
            : {},
          contributionHistory: objective.contributionHistory.filter(
            (contribution) => contribution.playerId === playerId,
          ),
          rewardHistory: objective.rewardHistory.filter((reward) => reward.playerId === playerId),
        },
      ]),
    ) as WorldState['cooperativeObjectives'];
    const sharedConstructionProjects = Object.fromEntries(
      Object.entries(source.sharedConstructionProjects).filter(([, project]) =>
        Boolean(settlements[project.settlementId]?.members[playerId]),
      ),
    );
    const blocked = source.social.blockedPlayers[playerId] ?? {};
    const messages = source.social.messages.filter((message) => {
      if (blocked[message.senderId]) return false;
      if (message.channel === 'global') return true;
      const settlement = message.settlementId ? settlements[message.settlementId] : undefined;
      return Boolean(settlement?.members[playerId]);
    });
    const relevantPlayerNames = new Set<string>([playerId]);
    for (const settlement of Object.values(settlements))
      for (const memberId of Object.keys(settlement.members)) relevantPlayerNames.add(memberId);
    for (const message of messages) relevantPlayerNames.add(message.senderId);
    const previousTerrain = previous?.terrain;
    const canReuseTerrain =
      previousTerrain !== undefined &&
      Object.keys(previousTerrain).length === relevantChunks.size * CHUNK_SIZE * CHUNK_SIZE &&
      [...relevantChunks].every((chunk) => {
        const [xText, yText] = chunk.split(':');
        return (
          previousTerrain[tileKey(Number(xText) * CHUNK_SIZE, Number(yText) * CHUNK_SIZE)] !==
          undefined
        );
      });
    const terrain: Record<string, TerrainTile> = canReuseTerrain ? previousTerrain : {};
    const elevation: Record<string, number> =
      canReuseTerrain && previous?.elevation ? previous.elevation : {};
    if (!canReuseTerrain || elevation !== previous?.elevation)
      fillChunkTiles(source.seed, relevantChunks, canReuseTerrain ? undefined : terrain, elevation);
    const territory = territoryBySector(source.players);
    const visibleState = {
      schemaVersion: source.schemaVersion,
      contentVersion: source.contentVersion,
      peaceful: source.peaceful,
      tick: source.tick,
      players: { [playerId]: player },
      buildings,
      threats,
      scouts,
      transfers: source.transfers.filter(
        (transfer) => transfer.fromPlayerId === playerId || transfer.toPlayerId === playerId,
      ),
      settlements,
      logisticsLinks,
      carriers,
      roads,
      cooperativeObjectives,
      // Which shared project the world is building, and how high its bar stands, is public.
      completedWorldProjects: source.completedWorldProjects,
      playerActivity: source.playerActivity[playerId]
        ? { [playerId]: source.playerActivity[playerId] }
        : {},
      onboardingReservations: source.onboardingReservations[playerId]
        ? { [playerId]: source.onboardingReservations[playerId] }
        : {},
      sharedConstructionProjects,
      social: {
        playerNames: Object.fromEntries(
          Object.entries(source.social.playerNames).filter(([id]) => relevantPlayerNames.has(id)),
        ),
        settlementNames: Object.fromEntries(
          Object.entries(source.social.settlementNames).filter(([id]) => Boolean(settlements[id])),
        ),
        blockedPlayers: { [playerId]: blocked },
        lastChatTick:
          source.social.lastChatTick[playerId] !== undefined
            ? { [playerId]: source.social.lastChatTick[playerId] }
            : {},
        messages,
        reports: [],
      },
      processedCommands: [],
      minedTiles: Object.fromEntries(
        Object.entries(source.minedTiles).filter(([tile]) => {
          const [xText, yText] = tile.split(':');
          return relevantChunks.has(chunkKeyFor(Number(xText), Number(yText)));
        }),
      ),
      territory,
    } as Omit<ClientWorldState, 'terrain' | 'elevation'>;
    return this.stabilizedStateFor({ ...visibleState, terrain, elevation }, previous);
  }

  /** Retains immutable client subtrees when their serialized content is unchanged. */
  private stabilizedStateFor(raw: ClientWorldState, previous?: ClientWorldState): ClientWorldState {
    const state = {} as ClientWorldState;
    const fingerprints = new Map<keyof ClientWorldState, string>();
    const previousFingerprints = previous ? this.#stateFingerprints.get(previous) : undefined;
    for (const key of Object.keys(raw) as Array<keyof ClientWorldState>) {
      if (previous && previousFingerprints && raw[key] === previous[key]) {
        const fingerprint = previousFingerprints.get(key);
        if (fingerprint !== undefined) fingerprints.set(key, fingerprint);
        Object.assign(state, { [key]: previous[key] });
        continue;
      }
      const fingerprint = JSON.stringify(raw[key]);
      fingerprints.set(key, fingerprint);
      if (previous && previousFingerprints?.get(key) === fingerprint)
        Object.assign(state, { [key]: previous[key] });
      else Object.assign(state, { [key]: structuredClone(raw[key]) });
    }
    this.#stateFingerprints.set(state, fingerprints);
    return state;
  }

  /** Reuses one world scan across every authorized client view in a broadcast. */
  private viewIndex() {
    if (this.#viewIndex?.version === this.#version && this.#viewIndex.world === this.#world)
      return this.#viewIndex;
    const buildingsByOwner = new Map<
      string,
      Array<{ id: string; building: WorldState['buildings'][string]; order: number }>
    >();
    const buildingsByChunk = new Map<
      string,
      Array<{ id: string; building: WorldState['buildings'][string]; order: number }>
    >();
    let order = 0;
    for (const [id, building] of Object.entries(this.#world.buildings)) {
      const entry = { id, building, order };
      const owned = buildingsByOwner.get(building.ownerId) ?? [];
      owned.push(entry);
      buildingsByOwner.set(building.ownerId, owned);
      const chunk = chunkKeyFor(building.x, building.y);
      const local = buildingsByChunk.get(chunk) ?? [];
      local.push(entry);
      buildingsByChunk.set(chunk, local);
      order += 1;
    }
    this.#viewIndex = {
      version: this.#version,
      world: this.#world,
      buildingsByOwner,
      buildingsByChunk,
    };
    return this.#viewIndex;
  }

  private send(connection: Connection, message: ServerMessage): void {
    connection.send(JSON.stringify(message));
  }

  private sendState(
    connection: Connection,
    message: Extract<ServerMessage, { type: 'worldBootstrap' | 'chunkSnapshot' | 'stateDelta' }>,
  ): void {
    const encoded = JSON.stringify(message);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (message.type === 'worldBootstrap' || message.type === 'chunkSnapshot') {
      this.#fullStateMessages += 1;
      this.#fullStateBytes += bytes;
    } else {
      this.#deltaStateMessages += 1;
      this.#deltaStateBytes += bytes;
    }
    connection.send(encoded);
  }

  private async saveCheckpoint(state = this.#world): Promise<void> {
    const startedAt = performance.now();
    try {
      const dirtyChunks = diffWorld(this.#checkpointBaseline, state).chunks;
      await this.persistence.saveCheckpoint(state, dirtyChunks);
      this.#checkpointBaseline = snapshot(state);
      this.#lastCheckpointTick = state.tick;
    } catch (error) {
      this.#checkpointFailures += 1;
      throw error;
    } finally {
      this.#lastCheckpointDurationMs = performance.now() - startedAt;
    }
  }
}
