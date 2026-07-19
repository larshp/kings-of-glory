import { Application, Container, Graphics } from 'pixi.js';
import { useEffect, useRef } from 'react';
import type { TerrainTile } from '@kings/protocol';
import { type Building, type Threat } from '@kings/simulation';
import type { CameraBindings } from './preferences.js';
import { screenToWorld, TILE_HEIGHT, TILE_WIDTH, worldToScreen } from './projection.js';

export interface WorldCanvasMetrics {
  readonly framesPerSecond: number;
  readonly renderedTiles: number;
  readonly visibleBuildings: number;
  readonly visibleThreats: number;
  readonly activeChunks: number;
}

export const WorldCanvas = ({
  buildings,
  threats,
  terrain,
  focus,
  cameraBindings,
  selectedTile,
  onSelectTile,
  onMetrics,
}: {
  buildings: readonly Building[];
  threats: readonly Threat[];
  terrain: Readonly<Record<string, TerrainTile>>;
  focus: { x: number; y: number };
  cameraBindings: CameraBindings;
  selectedTile: { x: number; y: number } | undefined;
  onSelectTile?: (tile: { x: number; y: number }) => void;
  onMetrics?: (metrics: WorldCanvasMetrics) => void;
}) => {
  const host = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const buildingLayer = useRef<Container | null>(null);
  const threatLayer = useRef<Container | null>(null);
  const selectionLayer = useRef<Container | null>(null);
  const latestBuildings = useRef(buildings);
  const latestThreats = useRef(threats);
  const latestTerrain = useRef(terrain);
  const latestFocus = useRef(focus);
  const latestCameraBindings = useRef(cameraBindings);
  const latestSelectTile = useRef(onSelectTile);
  const latestSelectedTile = useRef(selectedTile);
  const latestMetrics = useRef(onMetrics);
  latestBuildings.current = buildings;
  latestThreats.current = threats;
  latestTerrain.current = terrain;
  latestFocus.current = focus;
  latestCameraBindings.current = cameraBindings;
  latestSelectTile.current = onSelectTile;
  latestSelectedTile.current = selectedTile;
  latestMetrics.current = onMetrics;
  const renderBuildings = () => {
    const layer = buildingLayer.current;
    const app = appRef.current;
    if (!layer || !app) return;
    layer.removeChildren();
    for (const building of latestBuildings.current) {
      const position = worldToScreen({
        x: building.x - latestFocus.current.x,
        y: building.y - latestFocus.current.y,
      });
      const marker = new Graphics().rect(0, 0, 28, 22).fill({
        color:
          building.kind === 'settlement-center'
            ? '#e6c45d'
            : building.constructionTicks > 0
              ? '#95633b'
              : '#d8703a',
      });
      marker.position.set(position.x + app.renderer.width / 2 - 14, position.y + 80 - 22);
      layer.addChild(marker);
    }
  };
  const renderSelection = () => {
    const layer = selectionLayer.current;
    const app = appRef.current;
    const selected = latestSelectedTile.current;
    if (!layer || !app) return;
    layer.removeChildren();
    if (!selected) return;
    const position = worldToScreen({
      x: selected.x - latestFocus.current.x,
      y: selected.y - latestFocus.current.y,
    });
    const marker = new Graphics()
      .poly([
        0,
        TILE_HEIGHT / 2,
        TILE_WIDTH / 2,
        0,
        TILE_WIDTH,
        TILE_HEIGHT / 2,
        TILE_WIDTH / 2,
        TILE_HEIGHT,
      ])
      .stroke({ color: '#f6d365', width: 3 });
    marker.position.set(position.x + app.renderer.width / 2 - TILE_WIDTH / 2, position.y + 80);
    layer.addChild(marker);
  };
  const renderThreats = () => {
    const layer = threatLayer.current;
    const app = appRef.current;
    if (!layer || !app) return;
    layer.removeChildren();
    for (const threat of latestThreats.current) {
      const position = worldToScreen({
        x: threat.x - latestFocus.current.x,
        y: threat.y - latestFocus.current.y,
      });
      const marker = new Graphics()
        .circle(0, 0, 9)
        .fill({ color: '#dc4e4e' })
        .stroke({ color: '#fff1d6', width: 2 });
      marker.position.set(position.x + app.renderer.width / 2, position.y + 80 + TILE_HEIGHT / 2);
      layer.addChild(marker);
    }
  };
  useEffect(() => {
    const app = new Application();
    let disposed = false;
    let cleanupInput = () => {};
    let cleanupMetrics = () => {};
    void app
      .init({ resizeTo: host.current ?? window, background: '#17243a', antialias: true })
      .then(() => {
        if (!host.current || disposed) return;
        appRef.current = app;
        host.current.replaceChildren(app.canvas);
        for (let localX = -8; localX <= 8; localX += 1)
          for (let localY = -8; localY <= 8; localY += 1) {
            const x = latestFocus.current.x + localX;
            const y = latestFocus.current.y + localY;
            const position = worldToScreen({ x: localX, y: localY });
            const terrain = latestTerrain.current[`${x}:${y}`];
            const color =
              terrain === 'water'
                ? '#2f6d93'
                : terrain === 'ore'
                  ? '#6b6b79'
                  : terrain === 'grass'
                    ? (x + y) % 2 === 0
                      ? '#3b6a48'
                      : '#315d3d'
                    : '#1d2a3e';
            const tile = new Graphics()
              .poly([
                0,
                TILE_HEIGHT / 2,
                TILE_WIDTH / 2,
                0,
                TILE_WIDTH,
                TILE_HEIGHT / 2,
                TILE_WIDTH / 2,
                TILE_HEIGHT,
              ])
              .fill({ color });
            tile.position.set(
              position.x + app.renderer.width / 2 - TILE_WIDTH / 2,
              position.y + 80,
            );
            app.stage.addChild(tile);
          }
        const layer = new Container();
        buildingLayer.current = layer;
        app.stage.addChild(layer);
        const selection = new Container();
        selectionLayer.current = selection;
        app.stage.addChild(selection);
        const threatMarkers = new Container();
        threatLayer.current = threatMarkers;
        app.stage.addChild(threatMarkers);
        renderBuildings();
        renderSelection();
        renderThreats();
        let renderedFrames = 0;
        let sampleStartedAt = performance.now();
        const onTick = () => {
          renderedFrames += 1;
          const now = performance.now();
          const elapsed = now - sampleStartedAt;
          if (elapsed < 1_000) return;
          const chunks = new Set(
            Object.keys(latestTerrain.current).map((tile) => {
              const [x, y] = tile.split(':').map(Number);
              return `${Math.floor((x ?? 0) / 16)}:${Math.floor((y ?? 0) / 16)}`;
            }),
          );
          latestMetrics.current?.({
            framesPerSecond: Math.round((renderedFrames * 1_000) / elapsed),
            renderedTiles: 17 * 17,
            visibleBuildings: latestBuildings.current.length,
            visibleThreats: latestThreats.current.length,
            activeChunks: chunks.size,
          });
          renderedFrames = 0;
          sampleStartedAt = now;
        };
        app.ticker.add(onTick);
        cleanupMetrics = () => app.ticker.remove(onTick);
        const canvas = app.canvas;
        canvas.tabIndex = 0;
        canvas.setAttribute(
          'aria-label',
          'Isometric world map. Use arrow keys to select tiles and your configured camera controls to pan.',
        );
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let draggedDistance = 0;
        const onPointerDown = (event: PointerEvent) => {
          dragging = true;
          draggedDistance = 0;
          lastX = event.clientX;
          lastY = event.clientY;
          canvas.setPointerCapture(event.pointerId);
        };
        const onPointerMove = (event: PointerEvent) => {
          if (!dragging) return;
          const dx = event.clientX - lastX;
          const dy = event.clientY - lastY;
          draggedDistance += Math.abs(dx) + Math.abs(dy);
          app.stage.position.x += dx;
          app.stage.position.y += dy;
          lastX = event.clientX;
          lastY = event.clientY;
        };
        const onPointerUp = (event: PointerEvent) => {
          dragging = false;
          if (draggedDistance < 8) {
            const rectangle = canvas.getBoundingClientRect();
            const localX =
              (event.clientX - rectangle.left - app.stage.position.x) / app.stage.scale.x;
            const localY =
              (event.clientY - rectangle.top - app.stage.position.y) / app.stage.scale.y;
            const world = screenToWorld({
              x: localX - app.renderer.width / 2 + TILE_WIDTH / 2,
              y: localY - 80,
            });
            latestSelectTile.current?.({
              x: Math.round(world.x + latestFocus.current.x),
              y: Math.round(world.y + latestFocus.current.y),
            });
          }
          if (canvas.hasPointerCapture(event.pointerId))
            canvas.releasePointerCapture(event.pointerId);
        };
        const onWheel = (event: WheelEvent) => {
          event.preventDefault();
          const rectangle = canvas.getBoundingClientRect();
          const x = event.clientX - rectangle.left;
          const y = event.clientY - rectangle.top;
          const previous = app.stage.scale.x;
          const next = Math.max(0.5, Math.min(2.5, previous * (event.deltaY < 0 ? 1.1 : 0.9)));
          app.stage.position.x = x - ((x - app.stage.position.x) * next) / previous;
          app.stage.position.y = y - ((y - app.stage.position.y) * next) / previous;
          app.stage.scale.set(next);
        };
        const onKeyDown = (event: KeyboardEvent) => {
          const selected = latestSelectedTile.current ?? { x: 0, y: 0 };
          const step = event.shiftKey ? 4 : 1;
          const direction =
            event.key === 'ArrowUp'
              ? { x: 0, y: -step }
              : event.key === 'ArrowDown'
                ? { x: 0, y: step }
                : event.key === 'ArrowLeft'
                  ? { x: -step, y: 0 }
                  : event.key === 'ArrowRight'
                    ? { x: step, y: 0 }
                    : undefined;
          if (direction) {
            event.preventDefault();
            latestSelectTile.current?.({
              x: selected.x + direction.x,
              y: selected.y + direction.y,
            });
            return;
          }
          const pan = 48;
          const bindings = latestCameraBindings.current;
          if (Object.values(bindings).includes(event.code)) {
            event.preventDefault();
            if (event.code === bindings.panUp) app.stage.position.y += pan;
            if (event.code === bindings.panDown) app.stage.position.y -= pan;
            if (event.code === bindings.panLeft) app.stage.position.x += pan;
            if (event.code === bindings.panRight) app.stage.position.x -= pan;
          }
        };
        canvas.style.touchAction = 'none';
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('keydown', onKeyDown);
        cleanupInput = () => {
          canvas.removeEventListener('pointerdown', onPointerDown);
          canvas.removeEventListener('pointermove', onPointerMove);
          canvas.removeEventListener('pointerup', onPointerUp);
          canvas.removeEventListener('pointercancel', onPointerUp);
          canvas.removeEventListener('wheel', onWheel);
          canvas.removeEventListener('keydown', onKeyDown);
        };
      });
    return () => {
      disposed = true;
      cleanupInput();
      cleanupMetrics();
      appRef.current = null;
      buildingLayer.current = null;
      threatLayer.current = null;
      selectionLayer.current = null;
      app.destroy();
    };
  }, [terrain, focus.x, focus.y]);
  useEffect(() => {
    renderBuildings();
  }, [buildings]);
  useEffect(() => {
    renderSelection();
  }, [selectedTile]);
  useEffect(() => {
    renderThreats();
  }, [threats]);
  return <div className="world-canvas" ref={host} aria-label="Isometric world map" />;
};
