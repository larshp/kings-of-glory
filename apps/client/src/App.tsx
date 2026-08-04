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
  producers as producerDefinitions,
  recipes,
  resources as resourceDefinitions,
  technologies,
  threats as threatDefinitions,
  type TechnologyId,
} from '@kings/content';
import {
  PROTOCOL_VERSION,
  type ClientWorldState,
  type DirectoryEntry,
  type ServerMessage,
  type WorldMapChunkSummary,
} from '@kings/protocol';
import { type Building, type SettlementRole } from '@kings/simulation';
import { initialCameraFocus, WorldCanvas } from './WorldCanvas.js';
import type {
  OperationsOverlay,
  PickedEntity,
  WorldCanvasDebugState,
  WorldCanvasMetrics,
} from './WorldCanvas.js';
import { loadRenderAssets, spriteAtlasManifest, type RenderAssets } from './render-assets.js';
import {
  informationCategories,
  searchInformation,
  type InformationCategory,
  type InformationEntry,
} from './information-search.js';
import { groupNotifications, type NotificationSeverity } from './notifications.js';
import { synchronizeWorld } from './world-sync.js';
import {
  defaultPreferences,
  displayKey,
  loadPreferences,
  PREFERENCE_STORAGE_KEY,
  type CameraAction,
  type ClientPreferences,
  withCameraBinding,
} from './preferences.js';
import './style.css';

const defaultServerUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname || 'localhost'}:3001`;
const serverUrl = import.meta.env.VITE_SERVER_URL ?? defaultServerUrl;
const sessionUrl = new URL(serverUrl);
sessionUrl.protocol = sessionUrl.protocol === 'wss:' ? 'https:' : 'http:';
sessionUrl.pathname = '/session';
sessionUrl.search = '';
sessionUrl.hash = '';
const storedPlayerId = sessionStorage.getItem('kings-dev-player-id');
const fallbackPlayerId = storedPlayerId ?? `dev-${crypto.randomUUID().slice(0, 8)}`;
const playerIdPromise = (async () => {
  let resolvedPlayerId = fallbackPlayerId;
  try {
    const response = await fetch(sessionUrl, { method: 'POST', credentials: 'include' });
    if (response.ok) {
      const session = (await response.json()) as { playerId?: unknown };
      if (typeof session.playerId === 'string') resolvedPlayerId = session.playerId;
    }
  } catch {
    // Development remains usable while the local server starts; production WebSockets require a session.
  }
  sessionStorage.setItem('kings-dev-player-id', resolvedPlayerId);
  return resolvedPlayerId;
})();

const rejectionMessage = (code: string | undefined) => {
  const messages: Record<string, string> = {
    'invalid-coordinate': 'That map coordinate is invalid.',
    'out-of-range': 'That tile is too far from your settlement.',
    'resource-depleted': 'That deposit is exhausted. Try another resource tile.',
    'no-deposit-in-range':
      'Build extractors beside a deposit that still has yield: mines need ore, lumber camps need timber.',
    'outside-plot': 'Build inside your claimed territory.',
    'protected-area': 'That area preserves another settlement or its access route.',
    'reserved-resource': 'That resource is reserved for the nearest starting settlement.',
    occupied: 'Another building already occupies that tile.',
    'insufficient-wood': 'Gather more wood before starting this construction.',
    'insufficient-ore': 'Gather or transfer more ore first.',
    'insufficient-resources': 'Gather, craft, or transfer the required resources first.',
    'inventory-full': 'Move or use items to make inventory space.',
    'construction-incomplete': 'Wait for construction to finish before using this building.',
    busy: 'Wait for the current production batch to finish before changing its recipe.',
    'invalid-recipe': 'That recipe cannot run in this building.',
    'incompatible-building': 'Copy settings only between completed producers of the same kind.',
    'building-destroyed': 'Repair or demolish the destroyed building first.',
    'technology-locked': 'Research the required technology first.',
    'unknown-objective': 'That cooperative objective is no longer available.',
    'objective-complete': 'That cooperative objective is already complete.',
    'objective-incomplete': 'The objective must be completed before rewards can be claimed.',
    'objective-contribution-required': 'Contribute before claiming this objective reward.',
    'reward-already-claimed': 'You already claimed this objective reward.',
    'unknown-project': 'That shared construction project no longer exists.',
    'project-complete': 'That shared construction project is already fully funded.',
    'project-limit-reached': 'Complete an active settlement project before starting another.',
    'construction-limit-reached':
      'Complete or cancel an active construction before starting another.',
    'invalid-name':
      'Use the allowed length and only letters, numbers, spaces, periods, apostrophes, or hyphens.',
    'name-taken': 'That name is already in use.',
    'content-rejected': 'That text was rejected by the world moderation rules.',
    'chat-rate-limited': 'Wait a few world ticks before sending another message.',
    'invalid-message': 'Enter a non-empty message within the length limit.',
    'unknown-message': 'That chat message is no longer available.',
    'already-reported': 'You already reported that message.',
    'cannot-block-self': 'You cannot block yourself.',
    'not-explored': 'Explore that area before claiming it.',
    'not-adjacent': 'Claim a sector next to your existing territory.',
    'unknown-recipient': 'That recipient has not joined this world yet.',
    'unknown-settlement': 'That settlement is no longer available.',
    'settlement-permission-denied': 'Your settlement role does not permit that action.',
    'settlement-invite-missing': 'You do not have an active invitation to that settlement.',
    'already-settlement-member': 'That player is already a member of this settlement.',
    'not-settlement-member': 'That player is not a member of this settlement.',
    'cannot-leave-settlement-owner': 'Transfer ownership before leaving your own settlement.',
    'cannot-remove-settlement-owner': 'Transfer ownership before removing the current owner.',
    'cannot-transfer-settlement-ownership-to-self':
      'Choose another settlement member as the owner.',
    'cannot-delete-settlement-owner':
      'Transfer ownership of every settlement before deleting this account.',
    'account-deletion-confirmation-required': 'Type DELETE exactly to confirm account deletion.',
    'account-deleted': 'This player identity has been permanently deleted.',
    unauthorized: 'Your connection cannot perform that action for this player.',
    'persistence-failed': 'The world could not save your action. It was not applied.',
  };
  return messages[code ?? ''] ?? `Action rejected: ${code ?? 'unknown reason'}.`;
};

const setConnectionIndicator = (message: string, hidden = false) => {
  const indicator = document.getElementById('connection-indicator');
  if (!indicator) return;
  indicator.textContent = message;
  indicator.hidden = hidden;
};
const technologyCostLabel = (
  cost: Readonly<Partial<Record<'ore' | 'wood' | 'ingot' | 'tool', number>>>,
) =>
  Object.entries(cost)
    .map(([item, amount]) => `${amount} ${item}${amount === 1 ? '' : 's'}`)
    .join(', ');
const amountLabel = (amounts: object) =>
  Object.entries(amounts as Readonly<Record<string, number>>)
    .map(([item, amount]) => `${amount} ${item}`)
    .join(', ');
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

const recipeForBuilding = (building: Building) =>
  Object.values(recipes).find((recipe) => recipe.id === building.recipeId);
const buildingLabel = (kind: Building['kind']) => buildingDefinitions[kind].displayName;
const extractorForBuilding = (building: Building) =>
  extractorDefinitions[building.kind as keyof typeof extractorDefinitions];
/** Extractors and recipe producers share the settlement's worker pool and job priorities. */
const usesWorkers = (building: Building) =>
  Boolean(producerDefinitions[building.kind as keyof typeof producerDefinitions]) ||
  Boolean(extractorForBuilding(building));
const recipeOptionsForBuilding = (building: Building) => {
  const producer = producerDefinitions[building.kind as keyof typeof producerDefinitions];
  return producer
    ? Object.values(recipes).filter((recipe) =>
        (producer.recipeIds as readonly string[]).includes(recipe.id),
      )
    : [];
};

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

  useEffect(() => {
    if (!identity.ready) return;
    let stopped = false;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let attempts = 0;
    let reconnectAllowed = true;
    let activeConnection: WebSocket | undefined;
    const connect = () => {
      setStatus(attempts === 0 ? 'Connecting' : 'Reconnecting');
      const connection = new WebSocket(serverUrl);
      activeConnection = connection;
      socket.current = connection;
      connection.onopen = () => {
        if (stopped || socket.current !== connection) {
          connection.close();
          return;
        }
        setConnectionIndicator('Connected to the server. Loading your world…');
        attempts = 0;
        connection.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, playerId }));
        messageCount.current.sent += 1;
        setStatus('Connected');
        heartbeatTimer = window.setInterval(() => {
          if (connection.readyState === WebSocket.OPEN) {
            connection.send(JSON.stringify({ type: 'ping', nonce: crypto.randomUUID() }));
            messageCount.current.sent += 1;
          }
        }, 15_000);
      };
      connection.onerror = () => {
        setConnectionIndicator('Network error. Retrying the game server connection…');
        notify('The connection encountered a network error. Retrying…');
      };
      connection.onclose = (event) => {
        if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        if (stopped || !reconnectAllowed) return;
        if (event.code === 1012) {
          reconnectAllowed = false;
          setStatus('Maintenance');
          setConnectionIndicator('The game server is under maintenance. Please try again shortly.');
          notify('The server is saving the world for maintenance. Your actions are paused.');
          return;
        }
        if (event.code === 1002 && event.reason === 'Client upgrade required') {
          reconnectAllowed = false;
          setStatus('Upgrade required');
          setConnectionIndicator(
            'This game client is incompatible with the server. Refresh to update.',
          );
          notify('A newer game client is required. Refresh this page after it is deployed.');
          return;
        }
        setConnectionIndicator(
          `Server connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''}). Retrying…`,
        );
        notify(
          `Connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''}). Retrying…`,
        );
        attempts += 1;
        retryTimer = window.setTimeout(connect, Math.min(5_000, 250 * 2 ** Math.min(attempts, 5)));
      };
      connection.onmessage = ({ data }) => {
        if (stopped || socket.current !== connection) return;
        let message: ServerMessage;
        try {
          message = JSON.parse(data) as ServerMessage;
        } catch {
          setConnectionIndicator('The server sent an unreadable update. Reconnecting…');
          notify('The server sent an unreadable update. Reconnecting…');
          connection.close(1002, 'Malformed server message');
          return;
        }
        messageCount.current.received += 1;
        if (message.type === 'worldMapPage') {
          setWorldMap((current) => ({
            chunks: message.page.after
              ? [
                  ...(current?.chunks ?? []),
                  ...message.page.chunks.filter(
                    (chunk) =>
                      !current?.chunks.some(
                        (existing) => existing.x === chunk.x && existing.y === chunk.y,
                      ),
                  ),
                ]
              : [...message.page.chunks],
            ...(message.page.nextCursor ? { nextCursor: message.page.nextCursor } : {}),
            totalExploredChunks: message.page.totalExploredChunks,
          }));
          setWorldMapLoading(false);
        }
        if (message.type === 'directoryPage') {
          setDirectory((current) => ({
            entries: message.page.after
              ? [...(current?.entries ?? []), ...message.page.entries]
              : [...message.page.entries],
            ...(message.page.nextCursor ? { nextCursor: message.page.nextCursor } : {}),
          }));
        }
        if (message.type === 'welcome') {
          setStatus('Connected');
        }
        const updateStartedAt = performance.now();
        const synchronization = synchronizeWorld(
          { version: stateVersion.current, state: clientWorldState.current },
          message,
        );
        if (synchronization.sync.state !== clientWorldState.current) {
          setConnectionIndicator('Game world connected.', true);
          stateVersion.current = synchronization.sync.version;
          clientWorldState.current = synchronization.sync.state;
          resyncRequested.current = false;
          setState(synchronization.sync.state);
          setUpdateApplicationMs(performance.now() - updateStartedAt);
        }
        if (
          message.type === 'worldBootstrap' &&
          synchronization.sync.state &&
          !synchronization.sync.state.players[playerId]
        ) {
          sessionStorage.removeItem('kings-dev-player-id');
          window.location.reload();
          return;
        }
        if (
          synchronization.needsResync &&
          !resyncRequested.current &&
          connection.readyState === WebSocket.OPEN
        ) {
          resyncRequested.current = true;
          setStatus('Resynchronizing');
          connection.send(JSON.stringify({ type: 'resync', version: stateVersion.current ?? 0 }));
          messageCount.current.sent += 1;
        }
        if (message.type === 'commandAcknowledged') {
          const pending = pendingCommands.current.get(message.result.commandId);
          if (pending) {
            if (pending.message) notify(pending.message);
            pendingCommands.current.delete(message.result.commandId);
            pending.onAcknowledged?.();
          }
        }
        if (message.type === 'commandRejected') {
          pendingCommands.current.delete(message.result.commandId);
          notify(rejectionMessage(message.result.code));
        }
        if (message.type === 'maintenance') {
          reconnectAllowed = false;
          setStatus('Maintenance');
          setConnectionIndicator(message.message);
          notify(message.message);
        }
        if (message.type === 'error') {
          notify(message.message ?? 'Connection error');
          if (message.code === 'version-mismatch') {
            reconnectAllowed = false;
            setStatus('Upgrade required');
            setConnectionIndicator(
              'This game client is incompatible with the server. Refresh to update.',
            );
            notify('A newer game client is required. Refresh this page after it is deployed.');
            connection.close(1002, 'Client upgrade required');
          }
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      if (socket.current === activeConnection) socket.current = undefined;
      activeConnection?.close();
    };
  }, [identity.ready, playerId]);

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
  const progressionEra = player?.research.unlocked['territorial-charter']
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
        <div
          aria-labelledby="hud-tab-build"
          className="hud-panel"
          hidden={hudTab !== 'build'}
          id="hud-panel-build"
          role="tabpanel"
          tabIndex={0}
        >
          <p className="map-help">
            Map: drag to pan, scroll to zoom, arrows to select,{' '}
            {displayKey(preferences.camera.panUp)}/{displayKey(preferences.camera.panLeft)}/
            {displayKey(preferences.camera.panDown)}/{displayKey(preferences.camera.panRight)} to
            pan. Boulders mark ore deposits and conifers mark timber groves; both thin out as they
            are worked. An outlined sector is claimed — green is yours, blue is another
            settlement&apos;s.
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
                        const selected = state.buildings[selectedEntity.id];
                        return selected ? buildingLabel(selected.kind) : selectedEntity.id;
                      })()
                    : `raider ${selectedEntity.id}`}
                </p>
              )}
              {selectedTile && (
                <p>
                  Sector:{' '}
                  {selectedTerritoryOwner ? `claimed by ${selectedTerritoryOwner}` : 'unclaimed'}
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
                {selectedResource === 'ore'
                  ? 'ore'
                  : selectedResource === 'wood'
                    ? 'wood'
                    : 'resource'}
              </button>
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
                    className={
                      building.id === selectedBuildingId ? 'building selected' : 'building'
                    }
                    key={building.id}
                  >
                    <strong>{buildingLabel(building.kind)}</strong>
                    {building.id === selectedBuildingId && <span>Selected on the map</span>}
                    {building.ownerId !== playerId && <span>Shared by {building.ownerId}</span>}
                    <span>
                      Health {building.health}/{building.maxHealth}
                    </span>
                    {building.health < building.maxHealth && (
                      <span className="alert">
                        Damaged by a threat or acid rain. Repair to restore production and protect
                        this building.
                      </span>
                    )}
                    <span>
                      Inventory: ore {building.inventory.ore} · wood {building.inventory.wood} ·
                      ingot {building.inventory.ingot} · tool {building.inventory.tool}
                    </span>
                    {building.populationCapacity > 0 && (
                      <span>Housing capacity: {building.populationCapacity}</span>
                    )}
                    {building.constructionTicks > 0 ? (
                      <>
                        <span>Construction: {building.constructionTicks} worker ticks</span>
                        {Object.values(building.constructionMaterials).some(
                          (amount) => amount > 0,
                        ) && (
                          <span>
                            Delivery remaining: ore {building.constructionMaterials.ore} · wood{' '}
                            {building.constructionMaterials.wood} · ingot{' '}
                            {building.constructionMaterials.ingot} · tool{' '}
                            {building.constructionMaterials.tool}
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
                              Production: {building.progress}/{recipe.ticks} ticks
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
                              Extraction: {building.progress}/
                              {extractorForBuilding(building)!.ticksPerUnit} ticks per{' '}
                              {extractorForBuilding(building)!.item}
                            </span>
                            <span>Machine: {building.productionState.replaceAll('-', ' ')}</span>
                            {building.productionState === 'blocked-input' && (
                              <span className="alert">
                                Stalled: every deposit within{' '}
                                {extractorForBuilding(building)!.range} tiles is exhausted. Demolish
                                and rebuild beside another deposit.
                              </span>
                            )}
                            {building.productionState === 'blocked-output' && (
                              <span className="alert">
                                Stalled: this store is full. Withdraw items or link it to storage.
                              </span>
                            )}
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
                        <button
                          disabled={!canMoveItems || player.inventory.ore < 1}
                          onClick={() => transfer(building, 'ore', 'toBuilding')}
                        >
                          Load 1 ore
                        </button>
                        <button
                          disabled={!canMoveItems || player.inventory.wood < 1}
                          onClick={() => transfer(building, 'wood', 'toBuilding')}
                        >
                          Load 1 wood
                        </button>
                        <button
                          disabled={!canMoveItems || player.inventory.ingot < 1}
                          onClick={() => transfer(building, 'ingot', 'toBuilding')}
                        >
                          Load 1 ingot
                        </button>
                        <button
                          disabled={!canMoveItems || building.inventory.ingot < 1}
                          onClick={() => transfer(building, 'ingot', 'toPlayer')}
                        >
                          Take 1 ingot
                        </button>
                        <button
                          disabled={!canMoveItems || building.inventory.tool < 1}
                          onClick={() => transfer(building, 'tool', 'toPlayer')}
                        >
                          Take 1 tool
                        </button>
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
                        onClick={() =>
                          send({ type: 'cancelConstruction', buildingId: building.id })
                        }
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
                  Link completed storage or production buildings to a producer. Higher-priority
                  links reserve source and target capacity first; each link uses its configured
                  throughput.
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
                    !logisticsSourceId ||
                    !logisticsTargetId ||
                    !logisticsItems.includes(logisticsItem)
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
                  const canRemove =
                    link.ownerId === playerId ||
                    (source &&
                      target &&
                      ['owner', 'logistics'].includes(roleForBuilding(source) ?? '') &&
                      ['owner', 'logistics'].includes(roleForBuilding(target) ?? ''));
                  return (
                    <p className="logistics-link" key={link.id}>
                      {link.sourceBuildingId} → {link.targetBuildingId} ({link.item},{' '}
                      {link.throughputPerTick}/tick, {link.status.replaceAll('-', ' ')})
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
        <div
          aria-labelledby="hud-tab-settlement"
          className="hud-panel"
          hidden={hudTab !== 'settlement'}
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
                Jobs: {player.population.employed} employed · {player.population.unemployed}{' '}
                available
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
                      <details
                        className={`notification-group ${group.severity}`}
                        key={group.severity}
                      >
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
                  Shelter:{' '}
                  {player.population.capacity >= player.population.total ? 'met' : 'shortage'} (
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
                <li
                  className={
                    player.research.unlocked['territorial-charter'] ? 'complete' : undefined
                  }
                >
                  Expansion: research the Territorial Charter to claim explored sectors.
                </li>
              </ol>
              <p>
                Research: {player.research.activeTechnology ?? 'idle'} (
                {player.research.ticksRemaining} ticks)
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
              <section className="information-browser" aria-labelledby="information-browser-title">
                <h2 id="information-browser-title">Settlement information</h2>
                <p>
                  Search construction, recipes, inventories, population, research, defense, and
                  current alerts.
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
                        <span className={`information-category ${entry.category}`}>
                          {entry.category}
                        </span>
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
        <div
          aria-labelledby="hud-tab-world"
          className="hud-panel"
          hidden={hudTab !== 'world'}
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
              <button onClick={() => send({ type: 'explore', ...frontier })}>
                Explore frontier
              </button>
              <button
                disabled={!player.research.unlocked['territorial-charter']}
                onClick={() => send({ type: 'claimTerritory', ...frontier })}
              >
                Claim frontier sector
              </button>
              <section className="strategic-map" aria-labelledby="strategic-map-title">
                <h2 id="strategic-map-title">Strategic world map</h2>
                <p>
                  Aggregated explored chunks only. Entities hidden by fog are never included in
                  these summaries.
                </p>
                <button disabled={worldMapLoading} onClick={() => requestWorldMap()}>
                  {worldMapLoading && !worldMap ? 'Loading map…' : 'Refresh strategic map'}
                </button>
                {worldMap && (
                  <>
                    <p>
                      Showing {worldMap.chunks.length} of {worldMap.totalExploredChunks} explored
                      chunks.
                    </p>
                    <ul className="strategic-map-list">
                      {worldMap.chunks.map((chunk) => (
                        <li key={`${chunk.x}:${chunk.y}`}>
                          <strong>
                            {chunk.x}:{chunk.y}{' '}
                            {chunk.currentlyVisible ? '(visible)' : '(explored)'}
                          </strong>
                          <span>
                            Resources: {chunk.terrain.ore} ore tiles, {chunk.terrain.wood} timber
                            tiles
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
        <div
          aria-labelledby="hud-tab-coop"
          className="hud-panel"
          hidden={hudTab !== 'coop'}
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
                  Playing as {state.social.playerNames[playerId] ?? playerId}. Names are normalized,
                  unique, length-limited, and checked by server moderation rules.
                </p>
                <label htmlFor="player-name">Player display name</label>
                <input
                  id="player-name"
                  value={playerNameDraft}
                  maxLength={24}
                  onChange={(event) => setPlayerNameDraft(event.target.value)}
                  placeholder={state.social.playerNames[playerId] ?? 'Settler'}
                />
                <button
                  disabled={!playerNameDraft.trim()}
                  onClick={() => {
                    send(
                      { type: 'setPlayerName', name: playerNameDraft },
                      'Updated your player name.',
                    );
                    setPlayerNameDraft('');
                  }}
                >
                  Update player name
                </button>
                <details className="account-deletion">
                  <summary>Delete account</summary>
                  <p>
                    This permanently removes your private player state, buildings, scouts, land, and
                    memberships. Moderation and transaction ledgers retain server-side integrity
                    records with your display name removed. This player identity cannot be reused.
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
                    disabled={
                      ownedSettlements.length > 0 || accountDeletionConfirmation !== 'DELETE'
                    }
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
                        {state.social.settlementNames[settlement.id] ?? settlement.id}
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
                        Unblock {state.social.playerNames[blockedId] ?? blockedId}
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
                          <button onClick={() => setRecipientId(entry.playerId)}>
                            Send resources
                          </button>{' '}
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
                  <button onClick={() => requestDirectory(directory.nextCursor)}>
                    More results
                  </button>
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
                onChange={(event) =>
                  setRecipientItem(event.target.value as 'ore' | 'wood' | 'ingot' | 'tool')
                }
              >
                <option value="ore">Ore</option>
                <option value="wood">Wood</option>
                <option value="ingot">Ingot</option>
                <option value="tool">Tool</option>
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
                <p>
                  Owners invite members. Builders maintain production; logistics members move items.
                </p>
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
                      <strong>
                        {state.social.settlementNames[settlement.id] ?? settlement.id}
                      </strong>
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
                              <label htmlFor={`settlement-name-${settlement.id}`}>
                                Settlement name
                              </label>
                              <input
                                id={`settlement-name-${settlement.id}`}
                                value={settlementNameDraft}
                                maxLength={32}
                                onChange={(event) => setSettlementNameDraft(event.target.value)}
                                placeholder={
                                  state.social.settlementNames[settlement.id] ?? settlement.id
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
                                {state.social.playerNames[memberId] ?? memberId}: {memberRole}
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
                        {transfer.fromPlayerId === playerId
                          ? transfer.toPlayerId
                          : transfer.fromPlayerId}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
        <div
          aria-labelledby="hud-tab-settings"
          className="hud-panel"
          hidden={hudTab !== 'settings'}
          id="hud-panel-settings"
          role="tabpanel"
          tabIndex={0}
        >
          <section className="settings-panel" aria-labelledby="settings-title">
            <h2 id="settings-title">Accessibility and controls</h2>
            <label htmlFor="text-scale">Text size</label>
            <select
              id="text-scale"
              value={preferences.textScale}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  textScale: Number(event.target.value) as ClientPreferences['textScale'],
                }))
              }
            >
              <option value={100}>Default</option>
              <option value={120}>Large</option>
              <option value={140}>Extra large</option>
            </select>
            <label className="checkbox-label" htmlFor="reduced-motion">
              <input
                id="reduced-motion"
                type="checkbox"
                checked={preferences.reducedMotion}
                onChange={(event) =>
                  setPreferences((current) => ({ ...current, reducedMotion: event.target.checked }))
                }
              />
              Reduce motion
            </label>
            <p className="settings-help">Focus a camera binding, then press its replacement key.</p>
            {(
              [
                ['panUp', 'Pan up'],
                ['panLeft', 'Pan left'],
                ['panDown', 'Pan down'],
                ['panRight', 'Pan right'],
              ] as const
            ).map(([action, label]) => (
              <label key={action} htmlFor={`binding-${action}`}>
                {label}
                <input
                  id={`binding-${action}`}
                  className="binding-input"
                  readOnly
                  value={displayKey(preferences.camera[action])}
                  onKeyDown={rebindCamera(action)}
                  aria-describedby="camera-binding-help"
                />
              </label>
            ))}
            <p className="settings-help" id="camera-binding-help">
              Arrow keys always select tiles; camera bindings must be unique.
            </p>
            <button
              type="button"
              onClick={() => {
                setPreferences(defaultPreferences);
                notify('Accessibility and camera controls restored to defaults.');
              }}
            >
              Restore control defaults
            </button>
          </section>
          <details className="renderer-debug">
            <summary>Renderer diagnostics</summary>
            <p>Diagnostics are local-only and do not change the shared world.</p>
            <label className="checkbox-label" htmlFor="renderer-debug-enabled">
              <input
                id="renderer-debug-enabled"
                type="checkbox"
                checked={rendererDebug.enabled}
                onChange={(event) =>
                  setRendererDebug((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              Show map overlays
            </label>
            <label className="checkbox-label" htmlFor="renderer-debug-coordinates">
              <input
                id="renderer-debug-coordinates"
                type="checkbox"
                disabled={!rendererDebug.enabled}
                checked={rendererDebug.showCoordinates}
                onChange={(event) =>
                  setRendererDebug((current) => ({
                    ...current,
                    showCoordinates: event.target.checked,
                  }))
                }
              />
              Tile coordinates
            </label>
            <label className="checkbox-label" htmlFor="renderer-debug-chunks">
              <input
                id="renderer-debug-chunks"
                type="checkbox"
                disabled={!rendererDebug.enabled}
                checked={rendererDebug.showChunks}
                onChange={(event) =>
                  setRendererDebug((current) => ({ ...current, showChunks: event.target.checked }))
                }
              />
              Chunk labels
            </label>
            <label className="checkbox-label" htmlFor="renderer-debug-entities">
              <input
                id="renderer-debug-entities"
                type="checkbox"
                disabled={!rendererDebug.enabled}
                checked={rendererDebug.showEntityIds}
                onChange={(event) =>
                  setRendererDebug((current) => ({
                    ...current,
                    showEntityIds: event.target.checked,
                  }))
                }
              />
              Entity IDs
            </label>
            <label className="checkbox-label" htmlFor="renderer-debug-paths">
              <input
                id="renderer-debug-paths"
                type="checkbox"
                disabled={!rendererDebug.enabled}
                checked={rendererDebug.showPaths}
                onChange={(event) =>
                  setRendererDebug((current) => ({ ...current, showPaths: event.target.checked }))
                }
              />
              Threat paths
            </label>
          </details>
          <section className="operations-overlay" aria-labelledby="operations-overlay-title">
            <h2 id="operations-overlay-title">Operations overlay</h2>
            <label htmlFor="operations-overlay-select">
              Map layer
              <select
                id="operations-overlay-select"
                value={operationsOverlay}
                onChange={(event) => setOperationsOverlay(event.target.value as OperationsOverlay)}
              >
                <option value="none">None</option>
                <option value="resources">Resources</option>
                <option value="logistics">Logistics flow</option>
                <option value="production">Production state</option>
                <option value="bottlenecks">Bottlenecks</option>
              </select>
            </label>
            <p>Layers are local views of already-authorized world state.</p>
          </section>
          <details className="performance-panel">
            <summary>Performance</summary>
            <p>
              {canvasMetrics?.framesPerSecond ?? '—'} FPS · {canvasMetrics?.renderedTiles ?? '—'}{' '}
              tiles · {canvasMetrics?.visibleBuildings ?? '—'} buildings ·{' '}
              {canvasMetrics?.visibleThreats ?? '—'} threats
            </p>
            <p>
              {canvasMetrics?.activeChunks ?? '—'} active chunks · {messageRate.received} received/s
              · {messageRate.sent} sent/s
            </p>
            <p>
              {canvasMetrics?.renderObjectCount ?? '—'} render objects ·{' '}
              {renderAssets
                ? Math.round(
                    Object.values(spriteAtlasManifest).reduce(
                      (bytes, atlas) => bytes + atlas.width * atlas.height * 4,
                      0,
                    ) / 1024,
                  )
                : '—'}{' '}
              KiB estimated atlas memory · {updateApplicationMs.toFixed(2)} ms update apply
            </p>
          </details>
        </div>
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
