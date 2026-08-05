import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  buildings as buildingDefinitions,
  cooperativeObjectives as cooperativeObjectiveDefinitions,
  extractors as extractorDefinitions,
  logisticsLinks as logisticsDefinitions,
  recipes,
  resources as resourceDefinitions,
  technologies,
  threats as threatDefinitions,
  type TechnologyId,
} from '@kings/content';
import {
  type ClientWorldState,
  type DirectoryEntry,
  type WorldMapChunkSummary,
} from '@kings/protocol';
import { type Building, type SettlementRole } from '@kings/simulation';
import { CoopPanel } from './hud/CoopPanel.js';
import { SettingsPanel } from './hud/SettingsPanel.js';
import { fallbackPlayerId, playerIdPromise } from './connection-status.js';
import { useGameConnection } from './useGameConnection.js';
import { BuildPanel } from './hud/BuildPanel.js';
import { SettlementPanel } from './hud/SettlementPanel.js';
import { amountLabel, recipeForBuilding } from './hud/labels.js';
import { WorldPanel } from './hud/WorldPanel.js';
import { initialCameraFocus, WorldCanvas } from './WorldCanvas.js';
import type {
  OperationsOverlay,
  PickedEntity,
  WorldCanvasDebugState,
  WorldCanvasMetrics,
} from './WorldCanvas.js';
import { loadRenderAssets, type RenderAssets } from './render-assets.js';
import {
  searchInformation,
  type InformationCategory,
  type InformationEntry,
} from './information-search.js';
import { groupNotifications, type NotificationSeverity } from './notifications.js';
import {
  displayKey,
  loadPreferences,
  PREFERENCE_STORAGE_KEY,
  type CameraAction,
  withCameraBinding,
} from './preferences.js';
import './style.css';

// The dev server binds port 3001 on the IPv6 wildcard, and WSL only relays that
// to the Windows host as `::1` — so a page opened at the `127.0.0.1:5173` URL Vite
// prints would dial an unreachable `127.0.0.1:3001`. `localhost` resolves to a
// relayed address on both sides, so dev always dials it regardless of page host.
// Built clients keep following the page hostname so LAN and deployed hosts work.
/**
 * The HUD is grouped so the panel a player needs during play is never buried under
 * settings. Build stays first because it holds the moment-to-moment actions.
 */
const HUD_TABS = [
  { id: 'build', label: 'Build' },
  { id: 'settlement', label: 'Settlement' },
  { id: 'world', label: 'World' },
  { id: 'coop', label: 'Co-op' },
  { id: 'settings', label: 'Settings' },
] as const;
type HudTabId = (typeof HUD_TABS)[number]['id'];

export const App = () => {
  const [identity, setIdentity] = useState({ playerId: fallbackPlayerId, ready: false });
  const playerId = identity.playerId;
  const socket = useRef<WebSocket | undefined>(undefined);
  const sequence = useRef(0);
  const stateVersion = useRef<number | undefined>(undefined);
  const clientWorldState = useRef<ClientWorldState | undefined>(undefined);
  const resyncRequested = useRef(false);
  const pendingCommands = useRef(
    new Map<string, { message?: string; onAcknowledged?: () => void }>(),
  );
  const [state, setState] = useState<ClientWorldState>();
  const [status, setStatus] = useState('Connecting');
  // seq bumps on every message so an identical repeated toast (e.g. "Gathered
  // wood.") still re-shows and resets its auto-dismiss timer.
  const [notice, setNoticeState] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const notify = (text: string) => setNoticeState((previous) => ({ text, seq: previous.seq + 1 }));
  const dismissNotice = () => setNoticeState((previous) => ({ ...previous, text: '' }));
  const [selectedTile, setSelectedTile] = useState<{ x: number; y: number }>();
  const [selectedEntity, setSelectedEntity] = useState<PickedEntity>();
  const [hoveredTile, setHoveredTile] = useState<{ x: number; y: number }>();
  const [recipientId, setRecipientId] = useState('');
  const [recipientItem, setRecipientItem] = useState<'ore' | 'wood' | 'ingot' | 'tool'>('ingot');
  const [inviteeId, setInviteeId] = useState('');
  const [logisticsSourceId, setLogisticsSourceId] = useState('');
  const [logisticsTargetId, setLogisticsTargetId] = useState('');
  const [logisticsItem, setLogisticsItem] = useState<'ore' | 'wood' | 'ingot' | 'tool'>('ore');
  const [preferences, setPreferences] = useState(() =>
    loadPreferences(localStorage.getItem(PREFERENCE_STORAGE_KEY)),
  );
  const [canvasMetrics, setCanvasMetrics] = useState<WorldCanvasMetrics>();
  const [rendererError, setRendererError] = useState('');
  const [renderAssets, setRenderAssets] = useState<RenderAssets>();
  const [assetLoadError, setAssetLoadError] = useState('');
  const [assetLoadProgress, setAssetLoadProgress] = useState({ loaded: 0, total: 1 });
  const [assetLoadAttempt, setAssetLoadAttempt] = useState(0);
  const [rendererDebug, setRendererDebug] = useState<WorldCanvasDebugState>({
    enabled: false,
    showCoordinates: false,
    showChunks: false,
    showEntityIds: false,
    showPaths: false,
  });
  const [operationsOverlay, setOperationsOverlay] = useState<OperationsOverlay>('none');
  const [hudTab, setHudTab] = useState<HudTabId>('build');
  /** Standard tablist behaviour: arrows move between tabs, Home and End jump to the ends. */
  const moveHudTabFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, current: HudTabId) => {
    const index = HUD_TABS.findIndex((tab) => tab.id === current);
    const target =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (index + 1) % HUD_TABS.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index - 1 + HUD_TABS.length) % HUD_TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? HUD_TABS.length - 1
              : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = HUD_TABS[target]!.id;
    setHudTab(next);
    document.getElementById(`hud-tab-${next}`)?.focus();
  };
  const messageCount = useRef({ received: 0, sent: 0 });
  const [messageRate, setMessageRate] = useState({ received: 0, sent: 0 });
  const [updateApplicationMs, setUpdateApplicationMs] = useState(0);
  const [worldMap, setWorldMap] = useState<{
    chunks: WorldMapChunkSummary[];
    nextCursor?: string;
    totalExploredChunks: number;
  }>();
  const [worldMapLoading, setWorldMapLoading] = useState(false);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [directory, setDirectory] = useState<{
    entries: DirectoryEntry[];
    nextCursor?: string;
  }>();
  const [playerNameDraft, setPlayerNameDraft] = useState('');
  const [settlementNameDraft, setSettlementNameDraft] = useState('');
  const [chatText, setChatText] = useState('');
  const [chatSettlementId, setChatSettlementId] = useState('global');
  const [accountDeletionConfirmation, setAccountDeletionConfirmation] = useState('');
  const [informationQuery, setInformationQuery] = useState('');
  const [informationCategory, setInformationCategory] = useState<InformationCategory | 'all'>(
    'all',
  );

  useEffect(() => {
    let active = true;
    void playerIdPromise.then((resolvedPlayerId) => {
      if (active) setIdentity({ playerId: resolvedPlayerId, ready: true });
    });
    return () => {
      active = false;
    };
  }, []);

  useGameConnection({
    identity,
    playerId,
    socket,
    clientWorldState,
    stateVersion,
    resyncRequested,
    pendingCommands,
    messageCount,
    setState,
    setStatus,
    setWorldMap,
    setWorldMapLoading,
    setDirectory,
    setUpdateApplicationMs,
    notify,
  });

  useEffect(() => {
    let cancelled = false;
    setRenderAssets(undefined);
    setAssetLoadError('');
    loadRenderAssets((loaded, total) => {
      if (!cancelled) setAssetLoadProgress({ loaded, total });
    })
      .then((assets) => {
        if (!cancelled) setRenderAssets(assets);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setAssetLoadError(
            error instanceof Error ? error.message : 'The world artwork could not be loaded.',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [assetLoadAttempt]);

  useEffect(() => {
    localStorage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMessageRate(messageCount.current);
      messageCount.current = { received: 0, sent: 0 };
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice.text) return;
    const timer = window.setTimeout(
      () => setNoticeState((previous) => ({ ...previous, text: '' })),
      5_000,
    );
    return () => window.clearTimeout(timer);
  }, [notice.seq, notice.text]);

  const player = state?.players[playerId];
  const canAffordTechnology = (
    cost: Readonly<Partial<Record<'ore' | 'wood' | 'ingot' | 'tool', number>>>,
  ) => {
    if (!player) return false;
    return Object.entries(cost).every(
      ([item, amount]) => player.inventory[item as keyof typeof player.inventory] >= (amount ?? 0),
    );
  };
  const rebindCamera = (action: CameraAction) => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const updated = withCameraBinding(preferences, action, event.code);
    if (!updated) {
      notify('Choose a unique letter, digit, or arrow key for each camera direction.');
      return;
    }
    setPreferences(updated);
    notify(`Camera control updated to ${displayKey(event.code)}.`);
  };
  const send = (
    command: Record<string, unknown>,
    successMessage?: string,
    onAcknowledged?: () => void,
  ) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    const id = crypto.randomUUID();
    if (successMessage || onAcknowledged)
      pendingCommands.current.set(id, {
        ...(successMessage ? { message: successMessage } : {}),
        ...(onAcknowledged ? { onAcknowledged } : {}),
      });
    socket.current.send(
      JSON.stringify({
        type: 'command',
        command: { id, playerId, sequence: ++sequence.current, ...command },
      }),
    );
    messageCount.current.sent += 1;
  };
  const sendInterest = (chunks: readonly { x: number; y: number }[]) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    socket.current.send(JSON.stringify({ type: 'interest', chunks }));
    messageCount.current.sent += 1;
  };
  const requestWorldMap = (after?: string) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    setWorldMapLoading(true);
    socket.current.send(
      JSON.stringify({
        type: 'worldMap',
        requestId: `map-${crypto.randomUUID()}`,
        ...(after ? { after } : {}),
        limit: 64,
      }),
    );
    messageCount.current.sent += 1;
  };
  const requestDirectory = (after?: string) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    socket.current.send(
      JSON.stringify({
        type: 'directorySearch',
        requestId: `directory-${crypto.randomUUID()}`,
        query: directoryQuery.trim(),
        ...(after ? { after } : {}),
        limit: 20,
      }),
    );
    messageCount.current.sent += 1;
  };
  const plot = useMemo(() => player?.plot, [player]);
  const terrainAt = (x: number, y: number) => state?.terrain[`${x}:${y}`];
  const settlements = Object.values(state?.settlements ?? {});
  const roleForBuilding = (building: Building): SettlementRole | undefined => {
    if (building.ownerId === playerId) return 'owner';
    const roles = settlements
      .filter((settlement) => settlement.members[building.ownerId])
      .map((settlement) => settlement.members[playerId])
      .filter((role): role is SettlementRole => Boolean(role));
    return roles.includes('owner')
      ? 'owner'
      : roles.includes('logistics')
        ? 'logistics'
        : roles.includes('builder')
          ? 'builder'
          : roles.includes('member')
            ? 'member'
            : undefined;
  };
  const selectedBuildingId = selectedEntity?.type === 'building' ? selectedEntity.id : undefined;
  /**
   * A stable listing order, with whatever the player picked on the map first so a
   * large settlement does not require scrolling to reach the selected building.
   */
  const manageableBuildings = (
    state ? Object.values(state.buildings).filter((building) => roleForBuilding(building)) : []
  ).sort(
    (left, right) =>
      Number(right.id === selectedBuildingId) - Number(left.id === selectedBuildingId) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
  const canRouteItems = (building: Building) =>
    building.constructionTicks === 0 &&
    (roleForBuilding(building) === 'owner' || roleForBuilding(building) === 'logistics');
  const logisticsSources = manageableBuildings.filter(
    (building) =>
      (logisticsDefinitions.internalInventory.acceptedSourceKinds as readonly string[]).includes(
        building.kind,
      ) && canRouteItems(building),
  );
  const logisticsTargets = manageableBuildings.filter(
    (building) =>
      (logisticsDefinitions.internalInventory.acceptedTargetKinds as readonly string[]).includes(
        building.kind,
      ) && canRouteItems(building),
  );
  /** Water and mountains block construction, exactly as the server rules do. */
  const isOpenTerrain = (x: number, y: number) => {
    const terrain = terrainAt(x, y);
    return terrain !== undefined && terrain !== 'water' && terrain !== 'mountain';
  };
  /**
   * Mirrors the authoritative protected-area rules the client can see: a settlement keeps
   * a westward access lane from its centre, and every settlement keeps a buffer around its
   * plot. Without this the HUD would call tiles buildable that the server then rejects. The
   * server stays the judge: it also knows settlements this client cannot see.
   */
  const ownCenter = state?.buildings[`center-${playerId}`];
  const isProtectedArea = (x: number, y: number) => {
    if (plot && ownCenter && y === ownCenter.y && x >= plot.x && x < ownCenter.x) return true;
    const buffer = threatDefinitions['raider-swarm'].settlementBufferTiles;
    // Every plot is the same size and puts its centre two tiles inside the far corner, so a
    // visible foreign centre is enough to reconstruct that settlement's buffered plot.
    const size = plot?.size ?? 8;
    const offset = size - 2;
    return Object.values(state?.buildings ?? {}).some((building) => {
      if (building.kind !== 'settlement-center' || building.ownerId === playerId) return false;
      const minX = building.x - offset - buffer;
      const minY = building.y - offset - buffer;
      return x >= minX && y >= minY && x < minX + size + buffer * 2 && y < minY + size + buffer * 2;
    });
  };
  const fallbackPlacement = plot
    ? Array.from({ length: plot.size }, (_, x) =>
        Array.from({ length: plot.size }, (_, y) => ({ x: plot.x + x, y: plot.y + y })),
      )
        .flat()
        .find(
          (tile) =>
            isOpenTerrain(tile.x, tile.y) &&
            !isProtectedArea(tile.x, tile.y) &&
            !Object.values(state?.buildings ?? {}).some(
              (building) => building.x === tile.x && building.y === tile.y,
            ),
        )
    : undefined;
  const candidatePlacement = selectedTile ?? fallbackPlacement;
  const buildablePlacement = (candidate: { x: number; y: number } | undefined) => {
    const territory = candidate
      ? `${Math.floor(candidate.x / 8)}:${Math.floor(candidate.y / 8)}`
      : '';
    return candidate &&
      player?.territoryCells[territory] &&
      isOpenTerrain(candidate.x, candidate.y) &&
      !isProtectedArea(candidate.x, candidate.y) &&
      !Object.values(state?.buildings ?? {}).some(
        (building) => building.x === candidate.x && building.y === candidate.y,
      )
      ? candidate
      : undefined;
  };
  const placement = buildablePlacement(candidatePlacement);
  const previewCandidate = hoveredTile ?? candidatePlacement;
  const previewPlacement = buildablePlacement(previewCandidate);
  const selectedTerritoryOwner = selectedTile
    ? state?.territory[`${Math.floor(selectedTile.x / 8)}:${Math.floor(selectedTile.y / 8)}`]
    : undefined;
  const transfer = (
    building: Building,
    item: 'ore' | 'wood' | 'ingot' | 'tool',
    direction: 'toBuilding' | 'toPlayer',
  ) => send({ type: 'transfer', buildingId: building.id, item, amount: 1, direction });
  const frontier = plot ? { x: plot.x + 16, y: plot.y } : { x: 0, y: 0 };
  const activeThreats = state
    ? Object.values(state.threats).filter((threat) => {
        const target = state.buildings[threat.targetBuildingId];
        return target && roleForBuilding(target);
      })
    : [];
  const exploredChunkCount = Object.keys(player?.exploredChunks ?? {}).length;
  const visibleChunkCount = Object.keys(player?.visibleChunks ?? {}).length;
  const progressionEra = player?.research.unlocked.engineering
    ? 'Engineering path'
    : player?.research.unlocked.stewardship
      ? 'Stewardship path'
      : player?.research.unlocked['territorial-charter']
        ? 'Expansion era'
        : player?.research.unlocked.metallurgy
          ? 'Industry era'
          : 'Founding era';
  const transfers = state?.transfers ?? [];
  const personalSettlement = state?.settlements[`settlement-${playerId}`];
  const frontierBeacon = state?.cooperativeObjectives['frontier-beacon'];
  const frontierBeaconDefinition = cooperativeObjectiveDefinitions['frontier-beacon'];
  const sharedProjects = Object.values(state?.sharedConstructionProjects ?? {});
  const chatMessages = state?.social.messages ?? [];
  const blockedPlayerIds = Object.keys(state?.social.blockedPlayers[playerId] ?? {});
  const ownedSettlements = settlements.filter((settlement) => settlement.ownerId === playerId);
  const logisticsLinks = Object.values(state?.logisticsLinks ?? {});
  const logisticsTarget = state?.buildings[logisticsTargetId];
  const logisticsItems = logisticsTarget
    ? (() => {
        // Storage buffers any item; producers only accept their configured recipe inputs.
        if (logisticsTarget.kind === 'storage')
          return ['ore', 'wood', 'ingot', 'tool'] as Array<'ore' | 'wood' | 'ingot' | 'tool'>;
        const recipe = recipeForBuilding(logisticsTarget);
        return Object.keys(recipe?.input ?? {}) as Array<'ore' | 'wood' | 'ingot' | 'tool'>;
      })()
    : [];
  const actionTile = selectedTile ?? (plot ? { x: plot.x, y: plot.y } : { x: 0, y: 0 });
  const selectedResource = terrainAt(actionTile.x, actionTile.y);
  /**
   * Mirrors the authoritative extractor rule for explored tiles so the build menu can
   * explain an impossible site before the command is sent. The server stays the judge.
   */
  const depositInRange = (
    kind: keyof typeof extractorDefinitions,
    candidate: { x: number; y: number } | undefined,
  ) => {
    if (!candidate) return false;
    const extractor = extractorDefinitions[kind];
    for (let offsetX = -extractor.range; offsetX <= extractor.range; offsetX += 1) {
      const span = extractor.range - Math.abs(offsetX);
      for (let offsetY = -span; offsetY <= span; offsetY += 1) {
        const x = candidate.x + offsetX;
        const y = candidate.y + offsetY;
        if (terrainAt(x, y) !== extractor.terrain) continue;
        const mined = state?.minedTiles[`${x}:${y}`] ?? 0;
        if (mined < resourceDefinitions[extractor.terrain].yield) return true;
      }
    }
    return false;
  };
  const buildMenu = (
    [
      ['placeSmelter', 'smelter'],
      ['placeMine', 'mine'],
      ['placeLumberCamp', 'lumber-camp'],
      ['placeForester', 'forester'],
      ['placeStorage', 'storage'],
      ['placeHousing', 'housing'],
      ['placeHearth', 'hearth'],
      ['placeWorkshop', 'workshop'],
      ['placeWatchtower', 'watchtower'],
    ] as const
  ).map(([commandType, kind]) => {
    const definition = buildingDefinitions[kind];
    const cost = definition.cost.wood;
    const requiredTechnology = definition.requiredTechnology as TechnologyId | null;
    const locked = Boolean(requiredTechnology && !player?.research.unlocked[requiredTechnology]);
    const affordable = (player?.inventory.wood ?? 0) >= cost;
    const extractor = kind in extractorDefinitions ? (kind as 'mine' | 'lumber-camp') : undefined;
    const missingDeposit = Boolean(extractor && placement && !depositInRange(extractor, placement));
    const reason = !placement
      ? 'Select a buildable tile inside your territory.'
      : locked
        ? `${technologies[requiredTechnology!].displayName} required.`
        : !affordable
          ? `Needs ${cost - (player?.inventory.wood ?? 0)} more wood.`
          : missingDeposit
            ? `No ${extractorDefinitions[extractor!].terrain === 'ore' ? 'ore deposit' : 'timber grove'} within ${extractorDefinitions[extractor!].range} tiles.`
            : extractor
              ? `Extracts 1 ${extractorDefinitions[extractor].item} every ${extractorDefinitions[extractor].ticksPerUnit} ticks while staffed.`
              : '';
    return {
      commandType,
      kind,
      label: `Place ${definition.displayName.toLowerCase()} (${cost} wood)`,
      disabled: !placement || locked || !affordable || missingDeposit,
      reason,
    };
  });
  const ownedBuildings = Object.values(state?.buildings ?? {}).filter(
    (building) => building.ownerId === playerId,
  );
  const ownSmelter = ownedBuildings.find((building) => building.kind === 'smelter');
  const ownWorkshop = ownedBuildings.find((building) => building.kind === 'workshop');
  const hasCompletedHearth = ownedBuildings.some(
    (building) => building.kind === 'hearth' && building.constructionTicks === 0,
  );
  const onboardingSteps = player
    ? [
        {
          complete:
            player.inventory.ore > 0 ||
            Boolean(ownSmelter?.inventory.ore) ||
            player.inventory.ingot > 0,
          text: 'Gather ore and wood from nearby selected deposits.',
        },
        {
          complete: Boolean(ownSmelter?.constructionTicks === 0),
          text: 'Build and complete a smelter on a highlighted tile.',
        },
        {
          complete: player.inventory.ingot > 0 || Boolean(ownSmelter?.inventory.ingot),
          text: 'Supply the smelter with ore and produce an ingot.',
        },
        {
          complete: player.research.unlocked.metallurgy,
          text: 'Research metallurgy with one ingot.',
        },
        {
          complete: Boolean(ownWorkshop?.constructionTicks === 0),
          text: 'Build a workshop, then link or load its wood and ingot inputs.',
        },
        {
          complete: player.inventory.tool > 0 || Boolean(ownWorkshop?.inventory.tool),
          text: 'Forge tools for a Territorial Charter and prepare a watchtower.',
        },
      ]
    : [];
  const nextOnboardingStep = onboardingSteps.find((step) => !step.complete);
  const onboardingReservation = state?.onboardingReservations[playerId];
  const activeAlertEntries: Array<InformationEntry & { readonly severity: NotificationSeverity }> =
    player
      ? [
          ...(player.population.capacity <= player.population.total
            ? [
                {
                  id: 'alert-housing',
                  category: 'alerts' as const,
                  severity: 'warning' as const,
                  title: 'Housing is full',
                  detail: 'Build housing before the settlement can grow.',
                },
              ]
            : []),
          ...(player.population.satisfaction < 50 && player.population.total > 2
            ? [
                {
                  id: 'alert-wellbeing',
                  category: 'alerts' as const,
                  severity: 'warning' as const,
                  title: 'Low wellbeing',
                  detail: 'Surplus settlers may leave at the next settlement review.',
                },
              ]
            : []),
          ...(player.population.unemployed > 0
            ? [
                {
                  id: 'alert-unemployed',
                  category: 'alerts' as const,
                  severity: 'info' as const,
                  title: `${player.population.unemployed} settlers available`,
                  detail: 'Build or prioritize production and construction work.',
                },
              ]
            : []),
          ...(!hasCompletedHearth
            ? [
                {
                  id: 'alert-hearth',
                  category: 'alerts' as const,
                  severity: 'info' as const,
                  title: 'Hearth needed',
                  detail: 'Build a hearth to improve settlement wellbeing.',
                },
              ]
            : []),
          ...(activeThreats.length > 0
            ? [
                {
                  id: 'alert-threats',
                  category: 'alerts' as const,
                  severity: 'critical' as const,
                  title: `${activeThreats.length} active raider threat${activeThreats.length === 1 ? '' : 's'}`,
                  detail: 'Review damaged targets, repairs, and watchtower coverage.',
                },
              ]
            : []),
        ]
      : [];
  const alertGroups = groupNotifications(activeAlertEntries);
  const informationEntries: InformationEntry[] = player
    ? [
        ...Object.values(buildingDefinitions).map((definition) => {
          const instances = ownedBuildings.filter((building) => building.kind === definition.id);
          const constructing = instances.filter(
            (building) => building.constructionTicks > 0,
          ).length;
          const technology = definition.requiredTechnology
            ? technologies[definition.requiredTechnology]
            : undefined;
          return {
            id: `construction-${definition.id}`,
            category: 'construction' as const,
            title: definition.displayName,
            detail: `${amountLabel(definition.cost)}; ${definition.constructionTicks} worker ticks; ${instances.length} owned${constructing ? `, ${constructing} constructing` : ''}; ${technology ? `${technology.displayName} required` : 'available in the Founding era'}.`,
            keywords: [definition.id, technology?.displayName ?? 'unlocked'],
          };
        }),
        ...Object.values(recipes).map((recipe) => ({
          id: `recipe-${recipe.id}`,
          category: 'recipes' as const,
          title: recipe.id,
          detail: `${amountLabel(recipe.input)} → ${amountLabel(recipe.output)} in ${recipe.ticks} ticks.`,
          keywords: [...Object.keys(recipe.input), ...Object.keys(recipe.output)],
        })),
        {
          id: 'inventory-player',
          category: 'inventory' as const,
          title: 'Player inventory',
          detail: amountLabel(player.inventory),
          keywords: ['carried personal'],
        },
        ...manageableBuildings.map((building) => ({
          id: `inventory-${building.id}`,
          category: 'inventory' as const,
          title: `${buildingDefinitions[building.kind].displayName} · ${building.id}`,
          detail: `${amountLabel(building.inventory)}; ${building.inventoryCapacity} total capacity.`,
          keywords: [building.kind, building.productionState],
        })),
        {
          id: 'population-total',
          category: 'population' as const,
          title: 'Settlement population',
          detail: `${player.population.total}/${player.population.capacity} housed; ${player.population.employed} employed; ${player.population.unemployed} available; ${player.population.satisfaction} wellbeing.`,
          keywords: ['settlers jobs housing shelter satisfaction'],
        },
        ...Object.values(technologies).map((technology) => ({
          id: `research-${technology.id}`,
          category: 'research' as const,
          title: technology.displayName,
          detail: `${player.research.unlocked[technology.id] ? 'Unlocked' : player.research.activeTechnology === technology.id ? `${player.research.ticksRemaining} ticks remaining` : 'Available to research'}; costs ${amountLabel(technology.cost)}; prerequisites ${technology.prerequisites.join(', ') || 'none'}.`,
          keywords: [technology.id, ...technology.prerequisites],
        })),
        {
          id: 'defense-overview',
          category: 'defense' as const,
          title: 'Settlement defense',
          detail: `${activeThreats.length} active threats; ${ownedBuildings.filter((building) => building.kind === 'watchtower' && building.constructionTicks === 0).length} completed watchtowers.`,
          keywords: ['raiders watchtower repair health'],
        },
        ...activeThreats.map((threat) => ({
          id: `defense-${threat.id}`,
          category: 'defense' as const,
          title: `Raider ${threat.id}`,
          detail: `${threat.health} health; targeting ${threat.targetBuildingId} at ${threat.x}, ${threat.y}.`,
          keywords: ['threat attack target'],
        })),
        ...(activeAlertEntries.length > 0
          ? activeAlertEntries.map(({ severity, ...alert }) => ({
              ...alert,
              keywords: [...(alert.keywords ?? []), severity],
            }))
          : [
              {
                id: 'alerts-clear',
                category: 'alerts' as const,
                title: 'No active alerts',
                detail: 'Housing, wellbeing, employment, hearth, and defense checks are clear.',
              },
            ]),
      ]
    : [];
  const informationResults = searchInformation(
    informationEntries,
    informationQuery,
    informationCategory,
  );

  return (
    <main
      className={preferences.reducedMotion ? 'reduced-motion' : undefined}
      style={{ fontSize: `${preferences.textScale}%` }}
    >
      <WorldCanvas
        buildings={Object.values(state?.buildings ?? {})}
        threats={Object.values(state?.threats ?? {})}
        terrain={state?.terrain ?? {}}
        elevation={state?.elevation ?? {}}
        minedTiles={state?.minedTiles ?? {}}
        territory={state?.territory ?? {}}
        roads={state?.roads ?? {}}
        discoveries={Object.values(player?.discoveries ?? {})}
        logisticsLinks={logisticsLinks}
        operationsOverlay={operationsOverlay}
        cameraBindings={preferences.camera}
        focus={initialCameraFocus(Object.values(state?.buildings ?? {}), playerId, plot)}
        playerId={playerId}
        playerPlot={plot}
        hoveredTile={hoveredTile}
        selectedTile={selectedTile}
        placementPreview={
          previewCandidate
            ? { tile: previewCandidate, valid: Boolean(previewPlacement) }
            : undefined
        }
        onSelectTile={setSelectedTile}
        onSelectEntity={setSelectedEntity}
        onHoverTile={setHoveredTile}
        onMetrics={setCanvasMetrics}
        onVisibleChunks={sendInterest}
        onError={(message) => setRendererError(message)}
        assets={renderAssets}
        debug={rendererDebug}
      />
      <aside className="hud">
        <header className="hud-header">
          <h1>Kings of Glory</h1>
          <p className="status">{status}</p>
          {player && (
            <p className="resource-bar">
              Ore {player.inventory.ore} · Wood {player.inventory.wood} · Ingot{' '}
              {player.inventory.ingot} · Tool {player.inventory.tool}
            </p>
          )}
          {player && nextOnboardingStep && (
            <p className="onboarding-next">Next: {nextOnboardingStep.text}</p>
          )}
          {!renderAssets && !assetLoadError && (
            <section className="asset-loading" aria-live="polite" aria-label="Loading map artwork">
              <strong>Loading map artwork</strong>
              <span>
                {assetLoadProgress.loaded}/{assetLoadProgress.total} atlas
                {assetLoadProgress.total === 1 ? '' : 'es'} loaded
              </span>
            </section>
          )}
          {assetLoadError && (
            <section className="asset-loading error" role="alert">
              <strong>Map artwork unavailable</strong>
              <span>{assetLoadError}</span>
              <button onClick={() => setAssetLoadAttempt((attempt) => attempt + 1)}>
                Retry artwork
              </button>
            </section>
          )}
          {status === 'Maintenance' && (
            <p className="alert" role="alert">
              The server is completing maintenance. Refresh the page in a moment to reconnect.
            </p>
          )}
          {status === 'Upgrade required' && (
            <p className="alert" role="alert">
              This client no longer matches the server. Refresh the page to load the update.
            </p>
          )}
          {!state && (
            <section className="startup-card" aria-labelledby="startup-title">
              <h2 id="startup-title">Entering the global world</h2>
              <p>
                {status === 'Connected'
                  ? 'Preparing your settlement and nearby map…'
                  : 'Connecting to the local game server…'}
              </p>
              <p>
                Start both services with <code>npm run dev</code>, then refresh this page.
              </p>
            </section>
          )}
          {rendererError && (
            <p className="alert" role="alert">
              Map renderer unavailable: {rendererError}
            </p>
          )}
        </header>
        <nav className="hud-tabs" role="tablist" aria-label="Interface sections">
          {HUD_TABS.map(({ id, label }) => (
            <button
              aria-controls={`hud-panel-${id}`}
              aria-selected={hudTab === id}
              className={hudTab === id ? 'hud-tab selected' : 'hud-tab'}
              id={`hud-tab-${id}`}
              key={id}
              onClick={() => setHudTab(id)}
              onKeyDown={(event) => moveHudTabFocus(event, id)}
              role="tab"
              tabIndex={hudTab === id ? 0 : -1}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
        <BuildPanel
          hidden={hudTab !== 'build'}
          state={state}
          player={player}
          playerId={playerId}
          preferences={preferences}
          selectedTile={selectedTile}
          selectedEntity={selectedEntity}
          selectedBuildingId={selectedBuildingId}
          selectedResource={selectedResource}
          selectedTerritoryOwner={selectedTerritoryOwner}
          actionTile={actionTile}
          placement={placement}
          buildMenu={buildMenu}
          manageableBuildings={manageableBuildings}
          roleForBuilding={roleForBuilding}
          logisticsLinks={logisticsLinks}
          logisticsSources={logisticsSources}
          logisticsTargets={logisticsTargets}
          logisticsItems={logisticsItems}
          logisticsSourceId={logisticsSourceId}
          setLogisticsSourceId={setLogisticsSourceId}
          logisticsTargetId={logisticsTargetId}
          setLogisticsTargetId={setLogisticsTargetId}
          logisticsItem={logisticsItem}
          setLogisticsItem={setLogisticsItem}
          transfer={transfer}
          send={send}
        />
        <SettlementPanel
          hidden={hudTab !== 'settlement'}
          player={player}
          plot={plot}
          progressionEra={progressionEra}
          onboardingSteps={onboardingSteps ?? []}
          onboardingReservation={onboardingReservation}
          hasCompletedHearth={hasCompletedHearth}
          exploredChunkCount={exploredChunkCount}
          visibleChunkCount={visibleChunkCount}
          canAffordTechnology={canAffordTechnology}
          activeAlertEntries={activeAlertEntries}
          alertGroups={alertGroups}
          informationQuery={informationQuery}
          setInformationQuery={setInformationQuery}
          informationCategory={informationCategory}
          setInformationCategory={setInformationCategory}
          informationResults={informationResults}
          send={send}
        />
        <WorldPanel
          hidden={hudTab !== 'world'}
          player={player}
          activeThreats={activeThreats}
          frontier={frontier}
          worldMap={worldMap}
          worldMapLoading={worldMapLoading}
          requestWorldMap={requestWorldMap}
          send={send}
        />
        <CoopPanel
          hidden={hudTab !== 'coop'}
          state={state}
          player={player}
          playerId={playerId}
          selectedTile={selectedTile}
          settlements={settlements}
          ownedSettlements={ownedSettlements}
          personalSettlement={personalSettlement}
          sharedProjects={sharedProjects}
          frontierBeacon={frontierBeacon}
          frontierBeaconDefinition={frontierBeaconDefinition}
          transfers={transfers}
          chatMessages={chatMessages}
          chatText={chatText}
          setChatText={setChatText}
          chatSettlementId={chatSettlementId}
          setChatSettlementId={setChatSettlementId}
          blockedPlayerIds={blockedPlayerIds}
          directory={directory}
          directoryQuery={directoryQuery}
          setDirectoryQuery={setDirectoryQuery}
          requestDirectory={requestDirectory}
          inviteeId={inviteeId}
          setInviteeId={setInviteeId}
          recipientId={recipientId}
          setRecipientId={setRecipientId}
          recipientItem={recipientItem}
          setRecipientItem={setRecipientItem}
          playerNameDraft={playerNameDraft}
          setPlayerNameDraft={setPlayerNameDraft}
          settlementNameDraft={settlementNameDraft}
          setSettlementNameDraft={setSettlementNameDraft}
          accountDeletionConfirmation={accountDeletionConfirmation}
          setAccountDeletionConfirmation={setAccountDeletionConfirmation}
          send={send}
        />
        <SettingsPanel
          hidden={hudTab !== 'settings'}
          preferences={preferences}
          setPreferences={setPreferences}
          rebindCamera={rebindCamera}
          rendererDebug={rendererDebug}
          setRendererDebug={setRendererDebug}
          operationsOverlay={operationsOverlay}
          setOperationsOverlay={setOperationsOverlay}
          canvasMetrics={canvasMetrics}
          renderAssets={renderAssets}
          messageRate={messageRate}
          updateApplicationMs={updateApplicationMs}
          notify={notify}
        />
      </aside>
      <div className="toast-region" role="status" aria-live="polite">
        {notice.text && (
          <div className="toast" key={notice.seq}>
            <span className="toast-message">{notice.text}</span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={dismissNotice}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </main>
  );
};
