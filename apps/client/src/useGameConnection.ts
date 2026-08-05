import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { PROTOCOL_VERSION, type ClientWorldState, type ServerMessage } from '@kings/protocol';
import { rejectionMessage, serverUrl, setConnectionIndicator } from './connection-status.js';
import { synchronizeWorld } from './world-sync.js';
import type { DirectoryView } from './hud/CoopPanel.js';
import type { WorldMapView } from './hud/types.js';

/** Commands awaiting an acknowledgement, so an outcome can be reported to the player. */
type PendingCommands = Map<string, { message?: string; onAcknowledged?: () => void }>;

export interface GameConnectionOptions {
  readonly identity: { readonly playerId: string; readonly ready: boolean };
  readonly playerId: string;
  readonly socket: MutableRefObject<WebSocket | undefined>;
  readonly clientWorldState: MutableRefObject<ClientWorldState | undefined>;
  readonly stateVersion: MutableRefObject<number | undefined>;
  readonly resyncRequested: MutableRefObject<boolean>;
  readonly pendingCommands: MutableRefObject<PendingCommands>;
  readonly messageCount: MutableRefObject<{ received: number; sent: number }>;
  readonly setState: Dispatch<SetStateAction<ClientWorldState | undefined>>;
  readonly setStatus: Dispatch<SetStateAction<string>>;
  readonly setWorldMap: Dispatch<SetStateAction<WorldMapView | undefined>>;
  readonly setWorldMapLoading: Dispatch<SetStateAction<boolean>>;
  readonly setDirectory: Dispatch<SetStateAction<DirectoryView | undefined>>;
  readonly setUpdateApplicationMs: Dispatch<SetStateAction<number>>;
  readonly notify: (text: string) => void;
}

/**
 * Owns the game server connection: the socket's whole lifecycle, the handshake, applying
 * state and deltas, resynchronisation, and reconnect backoff. It lives outside the HUD
 * because none of it is rendering — it only feeds the state the HUD reads.
 */
export const useGameConnection = ({
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
}: GameConnectionOptions) => {
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
};
