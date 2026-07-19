import { useEffect, useRef } from 'react';
import type { TerrainTile } from '@kings/protocol';
import { type Building, type Threat } from '@kings/simulation';
import type { CameraBindings } from './preferences.js';
import {
  screenToTile,
  screenToWorld,
  TILE_HEIGHT,
  TILE_WIDTH,
  worldToScreen,
} from './projection.js';

export interface WorldCanvasMetrics {
  readonly framesPerSecond: number;
  readonly renderedTiles: number;
  readonly visibleBuildings: number;
  readonly visibleThreats: number;
  readonly activeChunks: number;
}

interface Viewport {
  readonly panX: number;
  readonly panY: number;
  readonly scale: number;
}

export interface VisibleTileBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly center: { x: number; y: number };
}

interface IsometricEntity {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export type PickedEntity =
  | { readonly type: 'building'; readonly id: string }
  | { readonly type: 'threat'; readonly id: string };

/** Threats render above buildings, so they win a click on the same tile. */
export const entityAtTile = (
  tile: { x: number; y: number },
  buildings: readonly Building[],
  threats: readonly Threat[],
): PickedEntity | undefined => {
  const threat = threats.find((candidate) => candidate.x === tile.x && candidate.y === tile.y);
  if (threat) return { type: 'threat', id: threat.id };
  const building = buildings.find((candidate) => candidate.x === tile.x && candidate.y === tile.y);
  return building ? { type: 'building', id: building.id } : undefined;
};

/** Filters first, then orders only the visible entities by stable isometric depth. */
export const visibleByIsometricDepth = <Entity extends IsometricEntity>(
  entities: readonly Entity[],
  focus: { x: number; y: number },
  radius = 9,
): Entity[] =>
  entities
    .filter(
      (entity) => Math.abs(entity.x - focus.x) <= radius && Math.abs(entity.y - focus.y) <= radius,
    )
    .sort(
      (left, right) =>
        left.x + left.y - (right.x + right.y) ||
        left.y - right.y ||
        left.id.localeCompare(right.id),
    );

/** Calculates the world tile rectangle needed to cover the current transformed viewport. */
export const visibleTileBounds = (
  width: number,
  height: number,
  focus: { x: number; y: number },
  viewport: Viewport,
): VisibleTileBounds => {
  const screenToAbsoluteWorld = (screenX: number, screenY: number) => {
    const local = screenToWorld({
      x: (screenX - width / 2 - viewport.panX) / viewport.scale,
      y: (screenY - 80 - viewport.panY) / viewport.scale,
    });
    return { x: focus.x + local.x, y: focus.y + local.y };
  };
  const corners = [
    screenToAbsoluteWorld(0, 0),
    screenToAbsoluteWorld(width, 0),
    screenToAbsoluteWorld(0, height),
    screenToAbsoluteWorld(width, height),
  ];
  const xValues = corners.map((corner) => corner.x);
  const yValues = corners.map((corner) => corner.y);
  return {
    minX: Math.floor(Math.min(...xValues)) - 2,
    maxX: Math.ceil(Math.max(...xValues)) + 2,
    minY: Math.floor(Math.min(...yValues)) - 2,
    maxY: Math.ceil(Math.max(...yValues)) + 2,
    center: screenToAbsoluteWorld(width / 2, height / 2),
  };
};

/** Stable, bounded chunk subscription derived from the current viewport tile rectangle. */
export const visibleChunkCoordinates = (bounds: VisibleTileBounds) => {
  const chunks: Array<{ x: number; y: number }> = [];
  for (let x = Math.floor(bounds.minX / 16); x <= Math.floor(bounds.maxX / 16); x += 1)
    for (let y = Math.floor(bounds.minY / 16); y <= Math.floor(bounds.maxY / 16); y += 1)
      chunks.push({ x, y });
  return chunks;
};

const terrainColor = (terrain: TerrainTile | undefined, x: number, y: number) =>
  terrain === 'water'
    ? '#2f6d93'
    : terrain === 'ore'
      ? '#6b6b79'
      : terrain === 'wood'
        ? '#7d5433'
        : terrain === 'grass'
          ? (x + y) % 2 === 0
            ? '#3b6a48'
            : '#315d3d'
          : (x + y) % 2 === 0
            ? '#29463c'
            : '#233d34';

export const WorldCanvas = ({
  buildings,
  threats,
  terrain,
  territory,
  focus,
  cameraBindings,
  selectedTile,
  placementPreview,
  onSelectTile,
  onSelectEntity,
  onHoverTile,
  onMetrics,
  onVisibleChunks,
  onError,
}: {
  buildings: readonly Building[];
  threats: readonly Threat[];
  terrain: Readonly<Record<string, TerrainTile>>;
  territory: Readonly<Record<string, string>>;
  focus: { x: number; y: number };
  cameraBindings: CameraBindings;
  selectedTile: { x: number; y: number } | undefined;
  placementPreview: { tile: { x: number; y: number }; valid: boolean } | undefined;
  onSelectTile?: (tile: { x: number; y: number }) => void;
  onSelectEntity?: (entity: PickedEntity | undefined) => void;
  onHoverTile?: (tile: { x: number; y: number } | undefined) => void;
  onMetrics?: (metrics: WorldCanvasMetrics) => void;
  onVisibleChunks?: (chunks: readonly { x: number; y: number }[]) => void;
  onError?: (message: string) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<Viewport>({ panX: 0, panY: 0, scale: 1 });
  const latestBuildings = useRef(buildings);
  const latestThreats = useRef(threats);
  const latestTerrain = useRef(terrain);
  const latestTerritory = useRef(territory);
  const latestFocus = useRef(focus);
  const latestCameraBindings = useRef(cameraBindings);
  const latestSelectedTile = useRef(selectedTile);
  const latestPlacementPreview = useRef(placementPreview);
  const latestSelectTile = useRef(onSelectTile);
  const latestSelectEntity = useRef(onSelectEntity);
  const latestHoverTile = useRef(onHoverTile);
  const latestMetrics = useRef(onMetrics);
  const latestVisibleChunks = useRef(onVisibleChunks);
  const latestError = useRef(onError);
  latestBuildings.current = buildings;
  latestThreats.current = threats;
  latestTerrain.current = terrain;
  latestTerritory.current = territory;
  latestFocus.current = focus;
  latestCameraBindings.current = cameraBindings;
  latestSelectedTile.current = selectedTile;
  latestPlacementPreview.current = placementPreview;
  latestSelectTile.current = onSelectTile;
  latestSelectEntity.current = onSelectEntity;
  latestHoverTile.current = onHoverTile;
  latestMetrics.current = onMetrics;
  latestVisibleChunks.current = onVisibleChunks;
  latestError.current = onError;

  const draw = () => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context) {
      latestError.current?.('Your browser could not create a 2D canvas for the world map.');
      return;
    }
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (!width || !height) return;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * density);
    const pixelHeight = Math.round(height * density);
    if (element.width !== pixelWidth || element.height !== pixelHeight) {
      element.width = pixelWidth;
      element.height = pixelHeight;
    }
    context.setTransform(density, 0, 0, density, 0, 0);
    context.clearRect(0, 0, width, height);
    const view = viewport.current;
    const tileBounds = visibleTileBounds(width, height, latestFocus.current, view);
    const visibleRadius = Math.max(
      Math.abs(tileBounds.minX - tileBounds.center.x),
      Math.abs(tileBounds.maxX - tileBounds.center.x),
      Math.abs(tileBounds.minY - tileBounds.center.y),
      Math.abs(tileBounds.maxY - tileBounds.center.y),
    );
    context.translate(width / 2 + view.panX, 80 + view.panY);
    context.scale(view.scale, view.scale);

    const diamond = (point: { x: number; y: number }, fill: string, stroke?: string) => {
      context.beginPath();
      context.moveTo(point.x, point.y + TILE_HEIGHT / 2);
      context.lineTo(point.x + TILE_WIDTH / 2, point.y);
      context.lineTo(point.x + TILE_WIDTH, point.y + TILE_HEIGHT / 2);
      context.lineTo(point.x + TILE_WIDTH / 2, point.y + TILE_HEIGHT);
      context.closePath();
      context.fillStyle = fill;
      context.fill();
      if (stroke) {
        context.strokeStyle = stroke;
        context.lineWidth = 3;
        context.stroke();
      }
    };

    for (let x = tileBounds.minX; x <= tileBounds.maxX; x += 1) {
      for (let y = tileBounds.minY; y <= tileBounds.maxY; y += 1) {
        diamond(
          worldToScreen({ x: x - latestFocus.current.x, y: y - latestFocus.current.y }),
          terrainColor(latestTerrain.current[`${x}:${y}`], x, y),
        );
        if (latestTerritory.current[`${Math.floor(x / 8)}:${Math.floor(y / 8)}`])
          diamond(
            worldToScreen({ x: x - latestFocus.current.x, y: y - latestFocus.current.y }),
            'rgba(86, 136, 217, 0.16)',
          );
      }
    }
    for (const building of visibleByIsometricDepth(
      latestBuildings.current,
      tileBounds.center,
      visibleRadius,
    )) {
      const position = worldToScreen({
        x: building.x - latestFocus.current.x,
        y: building.y - latestFocus.current.y,
      });
      context.fillStyle =
        building.kind === 'settlement-center'
          ? '#e6c45d'
          : building.constructionTicks > 0
            ? '#95633b'
            : '#d8703a';
      context.fillRect(position.x + TILE_WIDTH / 2 - 14, position.y + TILE_HEIGHT / 2 - 22, 28, 22);
      context.strokeStyle = '#182337';
      context.lineWidth = 2;
      context.strokeRect(
        position.x + TILE_WIDTH / 2 - 14,
        position.y + TILE_HEIGHT / 2 - 22,
        28,
        22,
      );
    }
    const selected = latestSelectedTile.current;
    if (selected) {
      diamond(
        worldToScreen({
          x: selected.x - latestFocus.current.x,
          y: selected.y - latestFocus.current.y,
        }),
        'rgba(0, 0, 0, 0)',
        '#f6d365',
      );
    }
    const preview = latestPlacementPreview.current;
    if (preview) {
      diamond(
        worldToScreen({
          x: preview.tile.x - latestFocus.current.x,
          y: preview.tile.y - latestFocus.current.y,
        }),
        preview.valid ? 'rgba(107, 190, 123, 0.35)' : 'rgba(215, 82, 82, 0.35)',
        preview.valid ? '#9fe2b1' : '#ff9d8a',
      );
    }
    for (const threat of visibleByIsometricDepth(
      latestThreats.current,
      tileBounds.center,
      visibleRadius,
    )) {
      const position = worldToScreen({
        x: threat.x - latestFocus.current.x,
        y: threat.y - latestFocus.current.y,
      });
      context.beginPath();
      context.arc(position.x + TILE_WIDTH / 2, position.y + TILE_HEIGHT / 2, 9, 0, Math.PI * 2);
      context.fillStyle = '#dc4e4e';
      context.fill();
      context.strokeStyle = '#fff1d6';
      context.lineWidth = 2;
      context.stroke();
    }
  };

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let animationFrame = 0;
    let visibleChunkSignature = '';
    let renderedFrames = 0;
    let sampleStartedAt = performance.now();
    const renderFrame = () => {
      draw();
      renderedFrames += 1;
      const now = performance.now();
      const visibleChunks = visibleChunkCoordinates(
        visibleTileBounds(
          element.clientWidth,
          element.clientHeight,
          latestFocus.current,
          viewport.current,
        ),
      );
      const nextVisibleChunkSignature = visibleChunks
        .map((chunk) => `${chunk.x}:${chunk.y}`)
        .join(',');
      if (nextVisibleChunkSignature !== visibleChunkSignature) {
        visibleChunkSignature = nextVisibleChunkSignature;
        latestVisibleChunks.current?.(visibleChunks);
      }
      const elapsed = now - sampleStartedAt;
      if (elapsed >= 1_000) {
        const metricsBounds = visibleTileBounds(
          element.clientWidth,
          element.clientHeight,
          latestFocus.current,
          viewport.current,
        );
        const metricsRadius = Math.max(
          Math.abs(metricsBounds.minX - metricsBounds.center.x),
          Math.abs(metricsBounds.maxX - metricsBounds.center.x),
          Math.abs(metricsBounds.minY - metricsBounds.center.y),
          Math.abs(metricsBounds.maxY - metricsBounds.center.y),
        );
        const chunks = new Set(
          Object.keys(latestTerrain.current).map((tile) => {
            const [x, y] = tile.split(':').map(Number);
            return `${Math.floor((x ?? 0) / 16)}:${Math.floor((y ?? 0) / 16)}`;
          }),
        );
        latestMetrics.current?.({
          framesPerSecond: Math.round((renderedFrames * 1_000) / elapsed),
          renderedTiles:
            (metricsBounds.maxX - metricsBounds.minX + 1) *
            (metricsBounds.maxY - metricsBounds.minY + 1),
          visibleBuildings: visibleByIsometricDepth(
            latestBuildings.current,
            metricsBounds.center,
            metricsRadius,
          ).length,
          visibleThreats: visibleByIsometricDepth(
            latestThreats.current,
            metricsBounds.center,
            metricsRadius,
          ).length,
          activeChunks: chunks.size,
        });
        renderedFrames = 0;
        sampleStartedAt = now;
      }
      animationFrame = requestAnimationFrame(renderFrame);
    };
    const resize = () => draw();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(element);
    let dragging = false;
    let draggedDistance = 0;
    let lastX = 0;
    let lastY = 0;
    const tileAtPointer = (event: PointerEvent) => {
      const rectangle = element.getBoundingClientRect();
      const view = viewport.current;
      const world = screenToTile({
        x: (event.clientX - rectangle.left - rectangle.width / 2 - view.panX) / view.scale,
        y: (event.clientY - rectangle.top - 80 - view.panY) / view.scale,
      });
      return {
        x: world.x + latestFocus.current.x,
        y: world.y + latestFocus.current.y,
      };
    };
    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      draggedDistance = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      element.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) {
        latestHoverTile.current?.(tileAtPointer(event));
        return;
      }
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      draggedDistance += Math.abs(dx) + Math.abs(dy);
      viewport.current = {
        ...viewport.current,
        panX: viewport.current.panX + dx,
        panY: viewport.current.panY + dy,
      };
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      if (draggedDistance < 8) {
        const tile = tileAtPointer(event);
        latestSelectTile.current?.(tile);
        latestSelectEntity.current?.(
          entityAtTile(tile, latestBuildings.current, latestThreats.current),
        );
        latestHoverTile.current?.(tile);
      }
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
    };
    const onPointerLeave = () => latestHoverTile.current?.(undefined);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const previous = viewport.current.scale;
      const next = Math.max(0.5, Math.min(2.5, previous * (event.deltaY < 0 ? 1.1 : 0.9)));
      viewport.current = { ...viewport.current, scale: next };
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
        latestSelectTile.current?.({ x: selected.x + direction.x, y: selected.y + direction.y });
        return;
      }
      const pan = 48;
      const bindings = latestCameraBindings.current;
      if (!Object.values(bindings).includes(event.code)) return;
      event.preventDefault();
      viewport.current = {
        ...viewport.current,
        panX:
          viewport.current.panX +
          (event.code === bindings.panLeft ? pan : event.code === bindings.panRight ? -pan : 0),
        panY:
          viewport.current.panY +
          (event.code === bindings.panUp ? pan : event.code === bindings.panDown ? -pan : 0),
      };
    };
    element.tabIndex = 0;
    element.setAttribute(
      'aria-label',
      'Isometric world map. Use arrow keys to select tiles and your configured camera controls to pan.',
    );
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('pointerleave', onPointerLeave);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('keydown', onKeyDown);
    animationFrame = requestAnimationFrame(renderFrame);
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('pointerleave', onPointerLeave);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return <canvas className="world-canvas" ref={canvas} />;
};
