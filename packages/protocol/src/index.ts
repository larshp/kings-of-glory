import type { Command, CommandResult, WorldState } from '@kings/simulation';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type ClientMessage =
  | { type: 'hello'; version: number; playerId: string }
  | { type: 'command'; command: Command }
  | { type: 'ping'; nonce: string };

export type ServerMessage =
  | { type: 'welcome'; version: number; playerId: string; state: WorldState }
  | { type: 'state'; version: number; state: WorldState }
  | { type: 'commandResult'; result: CommandResult }
  | { type: 'pong'; nonce: string }
  | { type: 'error'; code: 'bad-message' | 'version-mismatch' | 'message-too-large'; message: string };

export const parseClientMessage = (raw: string): ClientMessage | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const message = value as Record<string, unknown>;
    if (message.type === 'hello' && typeof message.version === 'number' && typeof message.playerId === 'string') return message as ClientMessage;
    if (message.type === 'command' && message.command && typeof message.command === 'object') return message as ClientMessage;
    if (message.type === 'ping' && typeof message.nonce === 'string') return message as ClientMessage;
    return undefined;
  } catch { return undefined; }
};
