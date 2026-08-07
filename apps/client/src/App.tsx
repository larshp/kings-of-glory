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
  logisticsLinks as logisticsDefinitions,
  recipes,
  technologies,
  threats as threatDefinitions,
} from '@kings/content';
import {
  type ClientWorldState,
  type DirectoryEntry,
  type WorldMapChunkSummary,
} from '@kings/protocol';
import { type Building, type ItemKind, type SettlementRole } from '@kings/simulation';
import { CoopPanel } from './hud/CoopPanel.js';
import { SettingsPanel } from './hud/SettingsPanel.js';
import { fallbackPlayerId, playerIdPromise } from './connection-status.js';
import { useGameConnection } from './useGameConnection.js';
import { BuildPanel } from './hud/BuildPanel.js';
import { ContextInspector } from './hud/ContextInspector.js';
import { SettlementPanel } from './hud/SettlementPanel.js';
import { amountLabel, ITEM_KINDS, recipeForBuilding } from './hud/labels.js';
import {
  buildMenuEntries,
  kindForHotkey,
  placementStatus,
  type PlacementRules,
} from './hud/build-menu.js';
import { researchEntries } from './hud/research.js';
import { ResourceBar } from './hud/ResourceBar.js';
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
import {
  appendNotice,
  groupNotifications,
  MESSAGE_LOG_LIMIT,
  type Notice,
  type NotificationSeverity,
} from './notifications.js';
import {
  inventoryRatesPerMinute,
  withInventorySample,
  type InventorySample,
} from './inventory-trend.js';
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
  { id: 'build', label: 'Build', glyph: 'B' },
  { id: 'settlement', label: 'Settlement', glyph: 'S' },
  { id: 'world', label: 'World', glyph: 'W' },
  { id: 'coop', label: 'Co-op', glyph: 'C' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
] as const;
type HudTabId = (typeof HUD_TABS)[number]['id'];

const MAP_LAYERS: readonly {
  id: OperationsOverlay;
  label: string;
  glyph: string;
}[] = [
  { id: 'none', label: 'Default', glyph: '◇' },
  { id: 'resources', label: 'Resources', glyph: 'R' },
  { id: 'logistics', label: 'Logistics', glyph: 'L' },
  { id: 'production', label: 'Production', glyph: 'P' },
  { id: 'bottlenecks', label: 'Bottlenecks', glyph: '!' },
];

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
  /**
   * Toasts are a queue rather than one slot: a burst of acknowledgements used to overwrite
   * each other, so players lost messages they never saw. The log keeps them for review after
   * the toast has faded, and each toast schedules its own dismissal so an older message is
   * not held on screen by a newer one.
   */
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const [messageLog, setMessageLog] = useState<readonly Notice[]>([]);
  const noticeCount = useRef(0);
  const dismissNotice = (id: number) =>
    setNotices((current) => current.filter((notice) => notice.id !== id));
  const notify = (text: string, severity: NotificationSeverity = 'info') => {
    const id = (noticeCount.current += 1);
    setNotices((current) => appendNotice(current, { text, severity }, id));
    setMessageLog((current) => appendNotice(current, { text, severity }, id, MESSAGE_LOG_LIMIT));
    // A repeat replaces the newest notice under a new id, so this also restarts its timer.
    window.setTimeout(() => dismissNotice(id), 5_000);
  };
  const [selectedTile, setSelectedTile] = useState<{ x: number; y: number }>();
  const [selectedEntity, setSelectedEntity] = useState<PickedEntity>();
  const [hoveredTile, setHoveredTile] = useState<{ x: number; y: number }>();
  const [recipientId, setRecipientId] = useState('');
  const [recipientItem, setRecipientItem] = useState<ItemKind>('ingot');
  const [inviteeId, setInviteeId] = useState('');
  const [logisticsSourceId, setLogisticsSourceId] = useState('');
  const [logisticsTargetId, setLogisticsTargetId] = useState('');
  const [logisticsItem, setLogisticsItem] = useState<ItemKind>('ore');
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
  /** The building the player armed, which then follows the pointer until it is placed. */
  const [armedKind, setArmedKind] = useState<Building['kind']>();
  const [inventorySamples, setInventorySamples] = useState<readonly InventorySample[]>([]);
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
  /**
   * Assigned on every render and read only when a key is pressed, so the window listener is
   * installed once while still acting on current research, materials, and bindings.
   */
  const latestHotkeyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      // Never take a key away from chat, a name field, or an open dropdown.
      if (
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')
      )
        return;
      latestHotkeyHandler.current(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const player = state?.players[playerId];
  /** Read by the sampling interval, which must not restart every time the world updates. */
  const latestInventory = useRef(player?.inventory);
  latestInventory.current = player?.inventory;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const inventory = latestInventory.current;
      if (!inventory) return;
      setInventorySamples((current) =>
        withInventorySample(current, { at: performance.now(), inventory }),
      );
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const inventoryRates = useMemo(
    () => inventoryRatesPerMinute(inventorySamples),
    [inventorySamples],
  );
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
  const transfer = (building: Building, item: ItemKind, direction: 'toBuilding' | 'toPlayer') =>
    send({ type: 'transfer', buildingId: building.id, item, amount: 1, direction });
  /** The sector both frontier actions target, described the way the server judges it. */
  const sectorKey = (tile: { x: number; y: number }) =>
    `${Math.floor(tile.x / 8)}:${Math.floor(tile.y / 8)}`;
  const selectedSector = selectedTile
    ? {
        explored: Boolean(
          player?.exploredChunks[
            `${Math.floor(selectedTile.x / 16)}:${Math.floor(selectedTile.y / 16)}`
          ],
        ),
        claimedBy: state?.territory[sectorKey(selectedTile)]
          ? state.territory[sectorKey(selectedTile)] === playerId
            ? ('you' as const)
            : ('other' as const)
          : undefined,
        adjacentToOwnClaim: (() => {
          const [x, y] = sectorKey(selectedTile).split(':').map(Number);
          return [`${x! + 1}:${y!}`, `${x! - 1}:${y!}`, `${x!}:${y! + 1}`, `${x!}:${y! - 1}`].some(
            (neighbor) => player?.territoryCells[neighbor],
          );
        })(),
      }
    : undefined;
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
  const research = player
    ? researchEntries({
        unlocked: player.research.unlocked,
        activeTechnology: player.research.activeTechnology,
        ticksRemaining: player.research.ticksRemaining,
        inventory: player.inventory,
      })
    : [];
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
        if (logisticsTarget.kind === 'storage') return ITEM_KINDS;
        const recipe = recipeForBuilding(logisticsTarget);
        return Object.keys(recipe?.input ?? {}) as ItemKind[];
      })()
    : [];
  const actionTile = selectedTile ?? (plot ? { x: plot.x, y: plot.y } : { x: 0, y: 0 });
  const selectedResource = terrainAt(actionTile.x, actionTile.y);
  const inspectBuilding = (building: Building) => {
    setSelectedTile({ x: building.x, y: building.y });
    setSelectedEntity({ type: 'building', id: building.id });
  };
  const closeInspector = () => {
    setSelectedTile(undefined);
    setSelectedEntity(undefined);
  };
  /**
   * The world facts a site is judged by, shared so the menu, the ghost on the map, and the
   * click that places a building can never disagree about whether a tile will be accepted.
   */
  const placementRules: PlacementRules = {
    unlocked: (technology) => Boolean(player?.research.unlocked[technology]),
    inventory: player?.inventory ?? { ore: 0, wood: 0, stone: 0, ingot: 0, brick: 0, tool: 0 },
    isOpenSite: (tile) => Boolean(buildablePlacement(tile)),
    terrainAt: (tile) => terrainAt(tile.x, tile.y),
    minedAmount: (tile) => state?.minedTiles[`${tile.x}:${tile.y}`] ?? 0,
  };
  const buildMenu = buildMenuEntries(placementRules);
  const armedEntry = buildMenu.find((entry) => entry.kind === armedKind);
  const armedStatus = armedKind
    ? placementStatus(armedKind, previewCandidate, placementRules)
    : undefined;
  /**
   * Arms a building for placement. Doing it from a hotkey also opens the Build tab, so the
   * armed entry and its cost are visible wherever the player pressed the key.
   */
  const armBuilding = (kind: Building['kind'] | undefined) => {
    if (!kind) {
      setArmedKind(undefined);
      return;
    }
    const entry = buildMenu.find((candidate) => candidate.kind === kind);
    if (!entry) return;
    if (entry.unavailable) {
      notify(`${entry.name}: ${entry.unavailable}`, 'warning');
      return;
    }
    setHudTab('build');
    setArmedKind(kind);
  };
  /**
   * A map click places the armed building where the site allows it, and otherwise only moves
   * the selection and answers why. Shift keeps the building armed for the next site.
   */
  const selectTile = (tile: { x: number; y: number }, modifiers: { shift: boolean }) => {
    setSelectedTile(tile);
    if (!armedKind || !armedEntry) return;
    const status = placementStatus(armedKind, tile, placementRules);
    if (!status.valid) {
      notify(`Cannot place ${armedEntry.name.toLowerCase()}: ${status.reason}`, 'warning');
      return;
    }
    send({ type: armedEntry.commandType, ...tile }, `Placing ${armedEntry.name.toLowerCase()}.`);
    if (!modifiers.shift) setArmedKind(undefined);
  };
  latestHotkeyHandler.current = (event) => {
    if (event.key === 'Escape') {
      setArmedKind(undefined);
      return;
    }
    // A camera binding on a digit keeps panning; only unbound digits arm a building.
    if (Object.values(preferences.camera).includes(event.code)) return;
    const kind = kindForHotkey(event.key);
    if (!kind) return;
    event.preventDefault();
    armBuilding(kind);
  };
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
        carriers={Object.values(state?.carriers ?? {})}
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
            ? {
                tile: previewCandidate,
                valid: armedKind ? Boolean(armedStatus?.valid) : Boolean(previewPlacement),
                ...(armedKind && armedEntry && armedStatus
                  ? {
                      armed: {
                        kind: armedKind,
                        name: armedEntry.name,
                        reason: armedStatus.reason,
                      },
                    }
                  : {}),
              }
            : undefined
        }
        onSelectTile={selectTile}
        onSelectEntity={setSelectedEntity}
        onHoverTile={setHoveredTile}
        onMetrics={setCanvasMetrics}
        onVisibleChunks={sendInterest}
        onError={(message) => setRendererError(message)}
        assets={renderAssets}
        debug={rendererDebug}
      />
      <header className="game-topbar">
        <div className="brand-lockup">
          <h1>Kings of Glory</h1>
          <p className="status">
            <span className="status-dot" aria-hidden="true" />
            {status}
          </p>
        </div>
        {player && <ResourceBar inventory={player.inventory} rates={inventoryRates} />}
        {player && nextOnboardingStep && (
          <p className="onboarding-next">
            <span>Next objective</span>
            {nextOnboardingStep.text}
          </p>
        )}
      </header>

      <section className="map-toolbar" aria-label="Map layers">
        <span className="map-toolbar-label">Map layers</span>
        {MAP_LAYERS.map((layer) => (
          <button
            aria-label={`${layer.label} map layer`}
            aria-pressed={operationsOverlay === layer.id}
            className={operationsOverlay === layer.id ? 'map-tool selected' : 'map-tool'}
            key={layer.id}
            onClick={() => setOperationsOverlay(layer.id)}
            title={layer.label}
            type="button"
          >
            <span aria-hidden="true">{layer.glyph}</span>
            <span>{layer.label}</span>
          </button>
        ))}
      </section>

      <aside className="hud" aria-label="Game controls">
        <nav className="hud-tabs" role="tablist" aria-label="Interface sections">
          {HUD_TABS.map(({ id, label, glyph }) => (
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
              title={label}
              type="button"
            >
              <span className="hud-tab-glyph" aria-hidden="true">
                {glyph}
              </span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="hud-surface">
          <header className="hud-header">
            {!renderAssets && !assetLoadError && (
              <section
                className="asset-loading"
                aria-live="polite"
                aria-label="Loading map artwork"
              >
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
          <BuildPanel
            hidden={hudTab !== 'build'}
            state={state}
            player={player}
            playerId={playerId}
            preferences={preferences}
            selectedBuildingId={selectedBuildingId}
            buildMenu={buildMenu}
            armedKind={armedKind}
            armedName={armedEntry?.name}
            armedStatus={armedStatus}
            onArm={armBuilding}
            onInspectBuilding={inspectBuilding}
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
            send={send}
          />
          <SettlementPanel
            hidden={hudTab !== 'settlement'}
            player={player}
            plot={plot}
            progressionEra={progressionEra}
            worldTick={state?.tick ?? 0}
            onboardingSteps={onboardingSteps ?? []}
            onboardingReservation={onboardingReservation}
            hasCompletedHearth={hasCompletedHearth}
            exploredChunkCount={exploredChunkCount}
            visibleChunkCount={visibleChunkCount}
            researchEntries={research}
            messageLog={messageLog}
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
            selectedTile={selectedTile}
            selectedSector={selectedSector}
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
            canvasMetrics={canvasMetrics}
            renderAssets={renderAssets}
            messageRate={messageRate}
            updateApplicationMs={updateApplicationMs}
            notify={notify}
          />
        </div>
      </aside>
      <ContextInspector
        state={state}
        player={player}
        playerId={playerId}
        selectedTile={selectedTile}
        selectedEntity={selectedEntity}
        selectedBuildingId={selectedBuildingId}
        selectedResource={selectedResource}
        selectedTerritoryOwner={selectedTerritoryOwner}
        actionTile={actionTile}
        placement={placement}
        manageableBuildings={manageableBuildings}
        roleForBuilding={roleForBuilding}
        transfer={transfer}
        send={send}
        onClose={closeInspector}
      />
      <div className="toast-region" role="status" aria-live="polite">
        {notices.map((notice) => (
          <div className={`toast ${notice.severity}`} key={notice.id}>
            <span className="toast-message">
              {notice.text}
              {notice.count > 1 ? ` ×${notice.count}` : ''}
            </span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismissNotice(notice.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </main>
  );
};
