import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  buildings as buildingDefinitions,
  producers as producerDefinitions,
  recipes,
  technologies,
} from '@kings/content';
import { PROTOCOL_VERSION, type ClientWorldState, type ServerMessage } from '@kings/protocol';
import { type Building, type SettlementRole } from '@kings/simulation';
import { WorldCanvas } from './WorldCanvas.js';
import type {
  OperationsOverlay,
  PickedEntity,
  WorldCanvasDebugState,
  WorldCanvasMetrics,
} from './WorldCanvas.js';
import { loadRenderAssets, type RenderAssets } from './render-assets.js';
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

const storedPlayerId = sessionStorage.getItem('kings-dev-player-id');
const playerId = storedPlayerId ?? `dev-${crypto.randomUUID().slice(0, 8)}`;
if (!storedPlayerId) sessionStorage.setItem('kings-dev-player-id', playerId);
const defaultServerUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname || 'localhost'}:3001`;

const rejectionMessage = (code: string | undefined) => {
  const messages: Record<string, string> = {
    'invalid-coordinate': 'That map coordinate is invalid.',
    'out-of-range': 'That tile is too far from your settlement.',
    'resource-depleted': 'That deposit is exhausted. Try another resource tile.',
    'outside-plot': 'Build inside your claimed territory.',
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
const recipeForBuilding = (building: Building) =>
  Object.values(recipes).find((recipe) => recipe.id === building.recipeId);
const recipeOptionsForBuilding = (building: Building) => {
  const producer = producerDefinitions[building.kind as keyof typeof producerDefinitions];
  return producer
    ? Object.values(recipes).filter((recipe) =>
        (producer.recipeIds as readonly string[]).includes(recipe.id),
      )
    : [];
};

export const App = () => {
  const socket = useRef<WebSocket | undefined>(undefined);
  const sequence = useRef(0);
  const stateVersion = useRef<number | undefined>(undefined);
  const clientWorldState = useRef<ClientWorldState | undefined>(undefined);
  const resyncRequested = useRef(false);
  const pendingCommands = useRef(new Map<string, string>());
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
  });
  const [operationsOverlay, setOperationsOverlay] = useState<OperationsOverlay>('none');
  const messageCount = useRef({ received: 0, sent: 0 });
  const [messageRate, setMessageRate] = useState({ received: 0, sent: 0 });

  useEffect(() => {
    let stopped = false;
    let retryTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let attempts = 0;
    let reconnectAllowed = true;
    let activeConnection: WebSocket | undefined;
    const connect = () => {
      setStatus(attempts === 0 ? 'Connecting' : 'Reconnecting');
      const connection = new WebSocket(import.meta.env.VITE_SERVER_URL ?? defaultServerUrl);
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
        if (message.type === 'welcome') {
          setStatus('Connected');
        }
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
          const successMessage = pendingCommands.current.get(message.result.commandId);
          if (successMessage) {
            notify(successMessage);
            pendingCommands.current.delete(message.result.commandId);
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
  }, []);

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
  const send = (command: Record<string, unknown>, successMessage?: string) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    const id = crypto.randomUUID();
    if (successMessage) pendingCommands.current.set(id, successMessage);
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
  const manageableBuildings = state
    ? Object.values(state.buildings).filter((building) => roleForBuilding(building))
    : [];
  const logisticsSources = manageableBuildings.filter(
    (building) =>
      (building.kind === 'storage' ||
        building.kind === 'smelter' ||
        building.kind === 'workshop') &&
      building.constructionTicks === 0 &&
      (roleForBuilding(building) === 'owner' || roleForBuilding(building) === 'logistics'),
  );
  const logisticsTargets = manageableBuildings.filter(
    (building) =>
      (building.kind === 'smelter' || building.kind === 'workshop') &&
      building.constructionTicks === 0 &&
      (roleForBuilding(building) === 'owner' || roleForBuilding(building) === 'logistics'),
  );
  const fallbackPlacement = plot
    ? Array.from({ length: plot.size }, (_, x) =>
        Array.from({ length: plot.size }, (_, y) => ({ x: plot.x + x, y: plot.y + y })),
      )
        .flat()
        .find(
          (tile) =>
            terrainAt(tile.x, tile.y) !== undefined &&
            terrainAt(tile.x, tile.y) !== 'water' &&
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
      terrainAt(candidate.x, candidate.y) !== undefined &&
      terrainAt(candidate.x, candidate.y) !== 'water' &&
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
  const transfers = state?.transfers ?? [];
  const personalSettlement = state?.settlements[`settlement-${playerId}`];
  const logisticsLinks = Object.values(state?.logisticsLinks ?? {});
  const logisticsTarget = state?.buildings[logisticsTargetId];
  const logisticsItems = logisticsTarget
    ? (() => {
        const definition = buildingDefinitions[logisticsTarget.kind];
        if (!('recipe' in definition)) return [] as Array<'ore' | 'wood' | 'ingot' | 'tool'>;
        const recipe = Object.values(recipes).find(
          (candidate) => candidate.id === definition.recipe,
        );
        return Object.keys(recipe?.input ?? {}) as Array<'ore' | 'wood' | 'ingot' | 'tool'>;
      })()
    : [];
  const actionTile = selectedTile ?? (plot ? { x: plot.x, y: plot.y } : { x: 0, y: 0 });
  const selectedResource = terrainAt(actionTile.x, actionTile.y);
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

  return (
    <main
      className={preferences.reducedMotion ? 'reduced-motion' : undefined}
      style={{ fontSize: `${preferences.textScale}%` }}
    >
      <WorldCanvas
        buildings={Object.values(state?.buildings ?? {})}
        threats={Object.values(state?.threats ?? {})}
        terrain={state?.terrain ?? {}}
        territory={state?.territory ?? {}}
        logisticsLinks={logisticsLinks}
        operationsOverlay={operationsOverlay}
        cameraBindings={preferences.camera}
        focus={
          plot
            ? { x: plot.x + Math.floor(plot.size / 2), y: plot.y + Math.floor(plot.size / 2) }
            : { x: 0, y: 0 }
        }
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
        <h1>Kings of Glory</h1>
        <p className="map-help">
          Map: drag to pan, scroll to zoom, arrows to select, {displayKey(preferences.camera.panUp)}
          /{displayKey(preferences.camera.panLeft)}/{displayKey(preferences.camera.panDown)}/
          {displayKey(preferences.camera.panRight)} to pan. Gray tiles are ore deposits, brown tiles
          are timber groves, and blue tiles are public claimed sectors.
        </p>
        <p className="status">{status}</p>
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
                setRendererDebug((current) => ({ ...current, showEntityIds: event.target.checked }))
              }
            />
            Entity IDs
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
            {canvasMetrics?.activeChunks ?? '—'} active chunks · {messageRate.received} received/s ·{' '}
            {messageRate.sent} sent/s
          </p>
        </details>
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
        {player ? (
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
            {player.population.capacity <= player.population.total && (
              <p className="alert">
                Housing is full. Build housing before your settlement can grow.
              </p>
            )}
            {player.population.satisfaction < 50 && player.population.total > 2 && (
              <p className="alert">
                Low wellbeing will cause surplus settlers to leave at the next settlement review.
              </p>
            )}
            {player.population.unemployed > 0 && (
              <p className="alert">
                {player.population.unemployed} settler
                {player.population.unemployed === 1 ? '' : 's'} need work. Build or prioritize a
                smelter.
              </p>
            )}
            {!hasCompletedHearth && (
              <p className="alert">Build a hearth to improve settlement wellbeing.</p>
            )}
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
            <p>
              Ore {player.inventory.ore} · Wood {player.inventory.wood} · Ingot{' '}
              {player.inventory.ingot} · Tool {player.inventory.tool}
            </p>
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
                  ? (state.buildings[selectedEntity.id]?.kind ?? selectedEntity.id)
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
            <section className="onboarding" aria-labelledby="getting-started-title">
              <h2 id="getting-started-title">Getting started</h2>
              {nextOnboardingStep && (
                <p className="onboarding-next">Next: {nextOnboardingStep.text}</p>
              )}
              <ol>
                {onboardingSteps.map((step) => (
                  <li className={step.complete ? 'complete' : undefined} key={step.text}>
                    {step.complete ? 'Done: ' : ''}
                    {step.text}
                  </li>
                ))}
              </ol>
            </section>
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
            <button
              disabled={!placement}
              onClick={() => placement && send({ type: 'placeSmelter', ...placement })}
            >
              Place smelter ({buildingDefinitions.smelter.cost.wood} wood)
            </button>
            <button
              disabled={!placement || !player.research.unlocked.metallurgy}
              onClick={() => placement && send({ type: 'placeWorkshop', ...placement })}
            >
              Place workshop ({buildingDefinitions.workshop.cost.wood} wood;{' '}
              {technologies.metallurgy.displayName} required)
            </button>
            <button
              disabled={!placement}
              onClick={() => placement && send({ type: 'placeStorage', ...placement })}
            >
              Place storage ({buildingDefinitions.storage.cost.wood} wood)
            </button>
            <button
              disabled={!placement}
              onClick={() => placement && send({ type: 'placeHousing', ...placement })}
            >
              Place housing ({buildingDefinitions.housing.cost.wood} wood)
            </button>
            <button
              disabled={!placement}
              onClick={() => placement && send({ type: 'placeHearth', ...placement })}
            >
              Place hearth ({buildingDefinitions.hearth.cost.wood} wood; wellbeing service)
            </button>
            <button
              disabled={!placement || !player.research.unlocked.metallurgy}
              onClick={() => placement && send({ type: 'placeWatchtower', ...placement })}
            >
              Place watchtower ({buildingDefinitions.watchtower.cost.wood} wood;{' '}
              {technologies.metallurgy.displayName} required)
            </button>
            <h2>Defense</h2>
            <p className={activeThreats.length > 0 ? 'threat-active' : ''}>
              {activeThreats.length > 0
                ? `${activeThreats.length} raider threat${activeThreats.length === 1 ? '' : 's'} active`
                : 'No active raider threats'}
            </p>
            <h2>Cooperation</h2>
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
                return (
                  <section className="settlement" key={settlement.id}>
                    <strong>{settlement.id}</strong>
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
                              {memberId}: {memberRole}
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
            <section className="automation-panel" aria-labelledby="automation-title">
              <h2 id="automation-title">Automation</h2>
              <p>
                Link completed storage or production buildings to a producer. Higher-priority links
                reserve source and target capacity first; each link uses its configured throughput.
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
            <h2>Progression</h2>
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
            <button onClick={() => send({ type: 'explore', ...frontier })}>Explore frontier</button>
            <button
              disabled={!player.research.unlocked['territorial-charter']}
              onClick={() => send({ type: 'claimTerritory', ...frontier })}
            >
              Claim frontier sector
            </button>
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
                <section className="building" key={building.id}>
                  <strong>{building.kind}</strong>
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
                    Inventory: ore {building.inventory.ore} · wood {building.inventory.wood} · ingot{' '}
                    {building.inventory.ingot} · tool {building.inventory.tool}
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
                          Delivery remaining: ore {building.constructionMaterials.ore} Â· wood{' '}
                          {building.constructionMaterials.wood} Â· ingot{' '}
                          {building.constructionMaterials.ingot} Â· tool{' '}
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
                      {(building.kind === 'smelter' || building.kind === 'workshop') && (
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
                      onClick={() => send({ type: 'cancelConstruction', buildingId: building.id })}
                    >
                      Cancel construction
                    </button>
                  )}
                </section>
              );
            })}
          </>
        ) : (
          <p>Loading world…</p>
        )}
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
