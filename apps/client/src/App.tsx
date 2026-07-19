import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorldState } from '@kings/simulation';
import { WorldCanvas } from './WorldCanvas.js';
import './style.css';

type ServerMessage = { type: string; state?: WorldState; result?: { accepted: boolean; code?: string }; message?: string };
const existingPlayerId = sessionStorage.getItem('kings-dev-player-id');
const playerId = existingPlayerId ?? `dev-${crypto.randomUUID().slice(0, 8)}`;
if (!existingPlayerId) sessionStorage.setItem('kings-dev-player-id', playerId);

export const App = () => {
  const socket = useRef<WebSocket | undefined>(undefined); const sequence = useRef(0);
  const [state, setState] = useState<WorldState>(); const [status, setStatus] = useState('Connecting'); const [notice, setNotice] = useState('');
  useEffect(() => {
    const connection = new WebSocket(import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:3001'); socket.current = connection;
    connection.onopen = () => { connection.send(JSON.stringify({ type: 'hello', version: 1, playerId })); setStatus('Connected'); };
    connection.onclose = () => setStatus('Disconnected');
    connection.onmessage = ({ data }) => { const message = JSON.parse(data) as ServerMessage; if (message.state) setState(message.state); if (message.result && !message.result.accepted) setNotice(message.result.code ?? 'Command rejected'); if (message.type === 'error') setNotice(message.message ?? 'Connection error'); };
    return () => connection.close();
  }, []);
  const player = state?.players[playerId];
  const send = (command: Record<string, unknown>) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify({ type: 'command', command: { id: crypto.randomUUID(), playerId, sequence: ++sequence.current, ...command } }));
  const plot = useMemo(() => player?.plot, [player]);
  const ownedBuildings = state ? Object.values(state.buildings).filter((building) => building.ownerId === playerId) : [];
  const placement = plot ? Array.from({ length: plot.size }, (_, x) => Array.from({ length: plot.size }, (_, y) => ({ x: plot.x + x, y: plot.y + y }))).flat().find((tile) => !Object.values(state?.buildings ?? {}).some((building) => building.x === tile.x && building.y === tile.y)) : undefined;
  return <main><WorldCanvas /><aside className="hud"><h1>Kings of Glory</h1><p className="status">{status}</p>{player ? <><p>Plot: {plot?.x}, {plot?.y}</p><p>Ore {player.inventory.ore} · Wood {player.inventory.wood} · Ingot {player.inventory.ingot}</p><button onClick={() => send({ type: 'gather', x: plot?.x ?? 0, y: plot?.y ?? 0 })}>Gather ore</button><button disabled={!placement} onClick={() => placement && send({ type: 'placeSmelter', ...placement })}>Place smelter (3 wood)</button><h2>Buildings</h2>{ownedBuildings.map((building) => <section className="building" key={building.id}><strong>{building.kind}</strong><span>Health {building.health}/{building.maxHealth}</span>{building.constructionTicks > 0 ? <span>Construction: {building.constructionTicks} ticks</span> : <><span>Production: {building.progress}/3</span>{building.kind === 'smelter' && <button onClick={() => send({ type: 'smelt', buildingId: building.id })}>Smelt ore</button>}<button onClick={() => send({ type: 'repair', buildingId: building.id })}>Repair</button>{building.kind !== 'settlement-center' && <button onClick={() => send({ type: 'demolish', buildingId: building.id })}>Demolish</button>}</>}{building.constructionTicks > 0 && building.kind !== 'settlement-center' && <button onClick={() => send({ type: 'cancelConstruction', buildingId: building.id })}>Cancel construction</button>}</section>)}</> : <p>Loading world…</p>}<p role="status">{notice}</p></aside></main>;
};
