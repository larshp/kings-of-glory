import { useEffect, useRef } from 'react';
import { threats as threatDefinitions } from '@kings/content';
import type { TerrainTile } from '@kings/protocol';
import type { Building, LogisticsLink, Threat } from '@kings/simulation';
import type { CameraBindings } from './preferences.js';
import { drawSprite, type RenderAssets, type SpriteId } from './render-assets.js';
import {
  ELEVATION_STEP,
  screenToRaisedTile,
  screenToTile,
  TILE_HEIGHT,
  TILE_WIDTH,
  worldToScreen,
} from './projection.js';
import {
  borderSides,
  cameraOrigin,
  entityAtTile,
  logisticsStatusColor,
  MAX_ELEVATION,
  productionRateLabel,
  resourceDecorationSprite,
  resourceIsReachable,
  summitColors,
  tileHoverLines,
  tileLayers,
  visibleByIsometricDepth,
  visibleChunkCoordinates,
  visibleRenderChunks,
  visibleTileBounds,
  type OperationsOverlay,
  type PickedEntity,
  type Viewport,
} from './world-canvas-model.js';

export * from './world-canvas-model.js';

export interface WorldCanvasMetrics {
  readonly framesPerSecond: number;
  readonly renderedTiles: number;
  readonly visibleBuildings: number;
  readonly visibleThreats: number;
  readonly activeChunks: number;
  readonly renderObjectCount: number;
}

export interface WorldCanvasDebugState {
  readonly enabled: boolean;
  readonly showCoordinates: boolean;
  readonly showChunks: boolean;
  readonly showEntityIds: boolean;
  readonly showPaths: boolean;
}

export const WorldCanvas = ({
  buildings,
  threats,
  terrain,
  elevation,
  minedTiles,
  territory,
  logisticsLinks,
  operationsOverlay,
  focus,
  playerId,
  playerPlot,
  cameraBindings,
  hoveredTile,
  selectedTile,
  placementPreview,
  onSelectTile,
  onSelectEntity,
  onHoverTile,
  onMetrics,
  onVisibleChunks,
  onError,
  assets,
  debug,
}: {
  buildings: readonly Building[];
  threats: readonly Threat[];
  terrain: Readonly<Record<string, TerrainTile>>;
  elevation: Readonly<Record<string, number>>;
  minedTiles: Readonly<Record<string, number>>;
  territory: Readonly<Record<string, string>>;
  logisticsLinks: readonly LogisticsLink[];
  operationsOverlay: OperationsOverlay;
  focus: { x: number; y: number };
  playerId: string;
  playerPlot: { readonly x: number; readonly y: number; readonly size: number } | undefined;
  cameraBindings: CameraBindings;
  hoveredTile: { x: number; y: number } | undefined;
  selectedTile: { x: number; y: number } | undefined;
  placementPreview: { tile: { x: number; y: number }; valid: boolean } | undefined;
  onSelectTile?: (tile: { x: number; y: number }) => void;
  onSelectEntity?: (entity: PickedEntity | undefined) => void;
  onHoverTile?: (tile: { x: number; y: number } | undefined) => void;
  onMetrics?: (metrics: WorldCanvasMetrics) => void;
  onVisibleChunks?: (chunks: readonly { x: number; y: number }[]) => void;
  onError?: (message: string) => void;
  assets: RenderAssets | undefined;
  debug: WorldCanvasDebugState | undefined;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<Viewport>({ panX: 0, panY: 0, scale: 1 });
  const latestBuildings = useRef(buildings);
  const latestThreats = useRef(threats);
  const latestTerrain = useRef(terrain);
  const latestElevation = useRef(elevation);
  const latestMinedTiles = useRef(minedTiles);
  const latestTerritory = useRef(territory);
  const latestLogisticsLinks = useRef(logisticsLinks);
  const latestOperationsOverlay = useRef(operationsOverlay);
  const latestFocus = useRef(focus);
  const latestPlayerId = useRef(playerId);
  const latestPlayerPlot = useRef(playerPlot);
  const latestCameraBindings = useRef(cameraBindings);
  const latestHoveredTile = useRef(hoveredTile);
  const latestSelectedTile = useRef(selectedTile);
  const latestPlacementPreview = useRef(placementPreview);
  const latestSelectTile = useRef(onSelectTile);
  const latestSelectEntity = useRef(onSelectEntity);
  const latestHoverTile = useRef(onHoverTile);
  const latestMetrics = useRef(onMetrics);
  const latestVisibleChunks = useRef(onVisibleChunks);
  const latestError = useRef(onError);
  const latestAssets = useRef(assets);
  const latestDebug = useRef(debug);
  latestBuildings.current = buildings;
  latestThreats.current = threats;
  latestTerrain.current = terrain;
  latestElevation.current = elevation;
  latestMinedTiles.current = minedTiles;
  latestTerritory.current = territory;
  latestLogisticsLinks.current = logisticsLinks;
  latestOperationsOverlay.current = operationsOverlay;
  latestFocus.current = focus;
  latestPlayerId.current = playerId;
  latestPlayerPlot.current = playerPlot;
  latestCameraBindings.current = cameraBindings;
  latestHoveredTile.current = hoveredTile;
  latestSelectedTile.current = selectedTile;
  latestPlacementPreview.current = placementPreview;
  latestSelectTile.current = onSelectTile;
  latestSelectEntity.current = onSelectEntity;
  latestHoverTile.current = onHoverTile;
  latestMetrics.current = onMetrics;
  latestVisibleChunks.current = onVisibleChunks;
  latestError.current = onError;
  latestAssets.current = assets;
  latestDebug.current = debug;

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
    const origin = cameraOrigin(width, height);
    context.save();
    context.translate(origin.x + view.panX, origin.y + view.panY);
    context.scale(view.scale, view.scale);

    const tilePoint = (x: number, y: number) =>
      worldToScreen({ x: x - latestFocus.current.x, y: y - latestFocus.current.y });
    /** `inset` shrinks the diamond towards its centre in screen pixels. */
    const diamondPath = (point: { x: number; y: number }, inset = 0) => {
      const centerX = point.x + TILE_WIDTH / 2;
      const centerY = point.y + TILE_HEIGHT / 2;
      const halfWidth = TILE_WIDTH / 2 - inset * 2;
      const halfHeight = TILE_HEIGHT / 2 - inset;
      context.beginPath();
      context.moveTo(centerX - halfWidth, centerY);
      context.lineTo(centerX, centerY - halfHeight);
      context.lineTo(centerX + halfWidth, centerY);
      context.lineTo(centerX, centerY + halfHeight);
      context.closePath();
    };
    const diamond = (point: { x: number; y: number }, fill: string, stroke?: string) => {
      diamondPath(point);
      context.fillStyle = fill;
      context.fill();
      if (stroke) {
        context.strokeStyle = stroke;
        context.lineWidth = 3;
        context.stroke();
      }
    };
    /** Adds one diamond side to the current path, using the screen-corner order. */
    const addSide = (
      point: { x: number; y: number },
      side: 'south-east' | 'south-west' | 'north-west' | 'north-east',
    ) => {
      const west = { x: point.x, y: point.y + TILE_HEIGHT / 2 };
      const north = { x: point.x + TILE_WIDTH / 2, y: point.y };
      const east = { x: point.x + TILE_WIDTH, y: point.y + TILE_HEIGHT / 2 };
      const south = { x: point.x + TILE_WIDTH / 2, y: point.y + TILE_HEIGHT };
      const [from, to] =
        side === 'south-east'
          ? [south, east]
          : side === 'south-west'
            ? [west, south]
            : side === 'north-west'
              ? [north, west]
              : [north, east];
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
    };

    const drawEntitySprite = (sprite: SpriteId, x: number, y: number) => {
      const position = tilePoint(x, y);
      const assets = latestAssets.current;
      if (assets)
        drawSprite(
          context,
          assets,
          sprite,
          position.x + TILE_WIDTH / 2,
          position.y + TILE_HEIGHT / 2,
        );
    };
    /** A soft contact shadow grounds a sprite on its tile instead of letting it float. */
    const drawContactShadow = (x: number, y: number, radius: number) => {
      const position = tilePoint(x, y);
      context.fillStyle = 'rgba(7, 13, 22, 0.32)';
      context.beginPath();
      context.ellipse(
        position.x + TILE_WIDTH / 2,
        position.y + TILE_HEIGHT / 2 + 2,
        radius,
        radius / 2.2,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
    };
    const drawHealthBar = (x: number, y: number, ratio: number) => {
      const position = tilePoint(x, y);
      const width = 26;
      const barX = position.x + TILE_WIDTH / 2 - width / 2;
      const barY = position.y + TILE_HEIGHT / 2 - 34;
      context.fillStyle = 'rgba(10, 16, 26, 0.85)';
      context.fillRect(barX - 1, barY - 1, width + 2, 6);
      context.fillStyle = ratio > 0.6 ? '#8fd694' : ratio > 0.3 ? '#f0c060' : '#e2706a';
      context.fillRect(barX, barY, Math.max(1, Math.round(width * ratio)), 4);
    };
    const terrainAt = (x: number, y: number) => latestTerrain.current[`${x}:${y}`];
    const levelAt = (x: number, y: number) => latestElevation.current[`${x}:${y}`] ?? 0;
    const sectorOwnerAt = (x: number, y: number) =>
      latestTerritory.current[`${Math.floor(x / 8)}:${Math.floor(y / 8)}`];
    const chunks = visibleRenderChunks(tileBounds);
    /**
     * Raised tiles overlap whatever is behind them, so they cannot be drawn in the flat
     * pass. They join the depth-sorted pass with buildings and threats instead.
     */
    const raisedTiles: Array<{ x: number; y: number; level: number }> = [];
    // Pass 1: flat ground, plus the inset pond or outcrop surface where a tile has one.
    for (const chunk of chunks)
      for (let x = chunk.minX; x <= chunk.maxX; x += 1)
        for (let y = chunk.minY; y <= chunk.maxY; y += 1) {
          const level = levelAt(x, y);
          if (level > 0) {
            raisedTiles.push({ x, y, level });
            continue;
          }
          const point = tilePoint(x, y);
          const layers = tileLayers(terrainAt(x, y), x, y);
          diamond(point, layers.base);
          if (!layers.patch) continue;
          diamondPath(point, layers.patch.inset);
          context.fillStyle = layers.patch.fill;
          context.fill();
          if (!layers.patch.sheen) continue;
          diamondPath(point, layers.patch.inset + 5);
          context.fillStyle = layers.patch.sheen;
          context.fill();
        }
    // Pass 2: sector ownership as borders rather than a wash that hides the terrain.
    for (const own of [true, false]) {
      context.beginPath();
      for (const chunk of chunks)
        for (let x = chunk.minX; x <= chunk.maxX; x += 1)
          for (let y = chunk.minY; y <= chunk.maxY; y += 1) {
            const owner = sectorOwnerAt(x, y);
            if (!owner || (owner === latestPlayerId.current) !== own) continue;
            for (const side of borderSides(x, y, sectorOwnerAt)) addSide(tilePoint(x, y), side);
          }
      context.strokeStyle = own ? 'rgba(159, 226, 177, 0.95)' : 'rgba(126, 168, 232, 0.85)';
      context.lineWidth = 2.5;
      context.stroke();
    }
    // Pass 3: deposits, drawn as clutter whose density shows the remaining yield.
    for (const chunk of chunks)
      for (let x = chunk.minX; x <= chunk.maxX; x += 1)
        for (let y = chunk.minY; y <= chunk.maxY; y += 1) {
          const decoration = resourceDecorationSprite(
            terrainAt(x, y),
            latestMinedTiles.current[`${x}:${y}`] ?? 0,
          );
          const assets = latestAssets.current;
          if (!decoration || !assets) continue;
          const point = tilePoint(x, y);
          drawSprite(
            context,
            assets,
            decoration,
            point.x + TILE_WIDTH / 2,
            point.y + TILE_HEIGHT / 2,
          );
        }
    // Pass 4: the hovered tile, so the pointer target is visible on the map itself.
    const hoveredForHighlight = latestHoveredTile.current;
    if (hoveredForHighlight) {
      diamondPath(tilePoint(hoveredForHighlight.x, hoveredForHighlight.y));
      context.strokeStyle = 'rgba(255, 243, 196, 0.8)';
      context.lineWidth = 2;
      context.stroke();
    }
    // Pass 5: tile markers. They belong to the ground, so sprites correctly occlude
    // them instead of a flat marker being painted over a building.
    const preview = latestPlacementPreview.current;
    if (preview)
      diamond(
        tilePoint(preview.tile.x, preview.tile.y),
        preview.valid ? 'rgba(107, 190, 123, 0.35)' : 'rgba(215, 82, 82, 0.35)',
        preview.valid ? '#9fe2b1' : '#ff9d8a',
      );
    const selected = latestSelectedTile.current;
    if (selected) drawEntitySprite('selection', selected.x, selected.y);
    if (latestOperationsOverlay.current === 'resources') {
      context.font = '10px system-ui';
      for (const chunk of visibleRenderChunks(tileBounds))
        for (let x = chunk.minX; x <= chunk.maxX; x += 1)
          for (let y = chunk.minY; y <= chunk.maxY; y += 1) {
            const resource = latestTerrain.current[`${x}:${y}`];
            if (resource !== 'ore' && resource !== 'wood') continue;
            const point = tilePoint(x, y);
            diamond(
              point,
              resource === 'ore' ? 'rgba(159, 188, 255, 0.32)' : 'rgba(139, 216, 134, 0.28)',
            );
            context.fillStyle = '#f4f0df';
            context.fillText(resource === 'ore' ? 'Ore' : 'Wood', point.x + 23, point.y + 21);
          }
    }
    /**
     * One depth-sorted pass for everything that stands above the ground. Mountains have
     * to share it with entities: a range must hide what is behind it and be hidden by
     * what stands in front of it, which separate passes cannot express.
     */
    const drawMountain = (x: number, y: number, level: number) => {
      const point = tilePoint(x, y);
      const top = { x: point.x, y: point.y - level * ELEVATION_STEP };
      const colors = summitColors(x, y, level);
      const west = { x: top.x, y: top.y + TILE_HEIGHT / 2 };
      const east = { x: top.x + TILE_WIDTH, y: top.y + TILE_HEIGHT / 2 };
      const south = { x: top.x + TILE_WIDTH / 2, y: top.y + TILE_HEIGHT };
      // Walls are drawn towards the viewer only, and only as far down as the neighbour.
      const wall = (from: { x: number; y: number }, to: { x: number; y: number }, drop: number) => {
        if (drop <= 0) return;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.lineTo(to.x, to.y + drop);
        context.lineTo(from.x, from.y + drop);
        context.closePath();
        context.fill();
      };
      context.fillStyle = colors.lit;
      wall(west, south, (level - levelAt(x, y + 1)) * ELEVATION_STEP);
      context.fillStyle = colors.shaded;
      wall(south, east, (level - levelAt(x + 1, y)) * ELEVATION_STEP);
      diamondPath(top);
      context.fillStyle = colors.top;
      context.fill();
      if (colors.facet) {
        diamondPath({ x: top.x + 6, y: top.y - 3 }, 9);
        context.fillStyle = colors.facet;
        context.fill();
      }
      // Outline the silhouette of a range, not every tile inside it, so plateaus read as
      // one landform instead of a grid.
      const edges = borderSides(x, y, (tileX, tileY) =>
        levelAt(tileX, tileY) === level ? `level-${level}` : undefined,
      );
      if (edges.length === 0) return;
      context.beginPath();
      for (const side of edges) addSide(top, side);
      context.strokeStyle = 'rgba(20, 29, 46, 0.55)';
      context.lineWidth = 1.5;
      context.stroke();
    };
    const raised = raisedTiles.map((tile) => ({
      depth: tile.x + tile.y,
      y: tile.y,
      order: 0,
      draw: () => drawMountain(tile.x, tile.y, tile.level),
    }));
    const buildingDrawables = visibleByIsometricDepth(
      latestBuildings.current,
      tileBounds.center,
      visibleRadius,
    ).map((building) => ({
      depth: building.x + building.y,
      y: building.y,
      order: 1,
      draw: () => {
        drawContactShadow(building.x, building.y, building.kind === 'watchtower' ? 14 : 20);
        drawEntitySprite(
          building.constructionTicks > 0 ? 'construction' : building.kind,
          building.x,
          building.y,
        );
        if (building.constructionTicks === 0 && building.health < building.maxHealth)
          drawHealthBar(building.x, building.y, building.health / building.maxHealth);
        if (latestDebug.current?.enabled && latestDebug.current.showEntityIds) {
          const position = tilePoint(building.x, building.y);
          context.fillStyle = '#f4f0df';
          context.font = '10px system-ui';
          context.fillText(building.id, position.x + TILE_WIDTH / 2, position.y - 8);
        }
      },
    }));
    const threatDrawables = visibleByIsometricDepth(
      latestThreats.current,
      tileBounds.center,
      visibleRadius,
    ).map((threat) => ({
      depth: threat.x + threat.y,
      y: threat.y,
      order: 2,
      draw: () => {
        drawContactShadow(threat.x, threat.y, 12);
        drawEntitySprite('raider', threat.x, threat.y);
        drawHealthBar(
          threat.x,
          threat.y,
          Math.max(0, Math.min(1, threat.health / threatDefinitions['raider-swarm'].health)),
        );
      },
    }));
    for (const drawable of [...raised, ...buildingDrawables, ...threatDrawables].sort(
      (left, right) => left.depth - right.depth || left.y - right.y || left.order - right.order,
    ))
      drawable.draw();
    const operationsOverlay = latestOperationsOverlay.current;
    if (operationsOverlay === 'logistics') {
      const buildingsById = new Map(
        latestBuildings.current.map((building) => [building.id, building]),
      );
      for (const link of [...latestLogisticsLinks.current].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        const source = buildingsById.get(link.sourceBuildingId);
        const target = buildingsById.get(link.targetBuildingId);
        if (!source || !target) continue;
        const sourcePoint = tilePoint(source.x, source.y);
        const targetPoint = tilePoint(target.x, target.y);
        context.beginPath();
        context.moveTo(sourcePoint.x + TILE_WIDTH / 2, sourcePoint.y + TILE_HEIGHT / 2);
        context.lineTo(targetPoint.x + TILE_WIDTH / 2, targetPoint.y + TILE_HEIGHT / 2);
        context.strokeStyle = logisticsStatusColor(link.status);
        context.lineWidth = 3;
        context.setLineDash(link.status === 'transferred' ? [] : [5, 3]);
        context.stroke();
        context.setLineDash([]);
        context.fillStyle = '#f4f0df';
        context.font = '10px system-ui';
        context.fillText(
          `${link.item} ${link.throughputPerTick}/t`,
          (sourcePoint.x + targetPoint.x) / 2 + TILE_WIDTH / 2,
          (sourcePoint.y + targetPoint.y) / 2 + TILE_HEIGHT / 2,
        );
      }
    }
    if (operationsOverlay === 'production' || operationsOverlay === 'bottlenecks')
      for (const building of visibleByIsometricDepth(
        latestBuildings.current,
        tileBounds.center,
        visibleRadius,
      )) {
        const bottleneck = ['blocked-input', 'blocked-output', 'unassigned', 'damaged'].includes(
          building.productionState,
        );
        if (operationsOverlay === 'bottlenecks' && !bottleneck) continue;
        const point = tilePoint(building.x, building.y);
        context.font = '11px system-ui';
        context.fillStyle = bottleneck ? '#ffd07a' : '#d7f2ff';
        const label =
          operationsOverlay === 'production'
            ? `${building.productionState.replaceAll('-', ' ')} ${productionRateLabel(building)}`
            : building.productionState.replaceAll('-', ' ');
        context.fillText(label, point.x + TILE_WIDTH / 2, point.y - 7);
      }
    const debugState = latestDebug.current;
    if (debugState?.enabled) {
      context.font = '10px ui-monospace, monospace';
      if (debugState.showPaths) {
        const buildingsById = new Map(
          latestBuildings.current.map((building) => [building.id, building]),
        );
        context.strokeStyle = 'rgba(255, 208, 122, 0.9)';
        context.lineWidth = 2;
        context.setLineDash([6, 4]);
        for (const threat of visibleByIsometricDepth(
          latestThreats.current,
          tileBounds.center,
          visibleRadius,
        )) {
          const target = buildingsById.get(threat.targetBuildingId);
          if (!target) continue;
          const from = tilePoint(threat.x, threat.y);
          const to = tilePoint(target.x, target.y);
          context.beginPath();
          context.moveTo(from.x + TILE_WIDTH / 2, from.y + TILE_HEIGHT / 2);
          context.lineTo(to.x + TILE_WIDTH / 2, to.y + TILE_HEIGHT / 2);
          context.stroke();
        }
        context.setLineDash([]);
      }
      if (debugState.showCoordinates)
        for (const chunk of visibleRenderChunks(tileBounds))
          for (let x = chunk.minX; x <= chunk.maxX; x += 1)
            for (let y = chunk.minY; y <= chunk.maxY; y += 1) {
              const point = tilePoint(x, y);
              context.fillStyle = 'rgba(244, 240, 223, 0.72)';
              context.fillText(`${x},${y}`, point.x + 27, point.y + 35);
            }
      if (debugState.showChunks)
        for (const chunk of visibleRenderChunks(tileBounds)) {
          const point = tilePoint(chunk.x * 16, chunk.y * 16);
          context.strokeStyle = '#80d4ff';
          context.lineWidth = 2;
          context.strokeRect(point.x + 32, point.y + 32, 1, 1);
          context.fillStyle = '#80d4ff';
          context.fillText(`chunk ${chunk.x}:${chunk.y}`, point.x + 34, point.y + 28);
        }
    }
    context.restore();

    const hovered = latestHoveredTile.current;
    if (hovered) {
      const hoveredLevel = latestElevation.current[`${hovered.x}:${hovered.y}`] ?? 0;
      const flatHoveredPoint = worldToScreen({
        x: hovered.x - latestFocus.current.x,
        y: hovered.y - latestFocus.current.y,
      });
      const hoveredPoint = {
        x: flatHoveredPoint.x,
        y: flatHoveredPoint.y - hoveredLevel * ELEVATION_STEP,
      };
      const screenPoint = {
        x: origin.x + view.panX + (hoveredPoint.x + TILE_WIDTH / 2) * view.scale,
        y: origin.y + view.panY + (hoveredPoint.y + TILE_HEIGHT / 2) * view.scale,
      };
      const territoryOwner =
        latestTerritory.current[`${Math.floor(hovered.x / 8)}:${Math.floor(hovered.y / 8)}`];
      const lines = tileHoverLines({
        tile: hovered,
        terrain: latestTerrain.current[`${hovered.x}:${hovered.y}`],
        elevation: latestElevation.current[`${hovered.x}:${hovered.y}`] ?? 0,
        minedAmount: latestMinedTiles.current[`${hovered.x}:${hovered.y}`] ?? 0,
        resourceReachable: resourceIsReachable(hovered, latestPlayerPlot.current),
        territoryOwner,
        playerId: latestPlayerId.current,
        placementValid:
          latestPlacementPreview.current?.tile.x === hovered.x &&
          latestPlacementPreview.current.tile.y === hovered.y &&
          latestPlacementPreview.current.valid,
        building: latestBuildings.current.find(
          (candidate) => candidate.x === hovered.x && candidate.y === hovered.y,
        ),
        threat: latestThreats.current.find(
          (candidate) => candidate.x === hovered.x && candidate.y === hovered.y,
        ),
      });
      const hoverDescription = lines.join('. ');
      if (element.getAttribute('aria-description') !== hoverDescription)
        element.setAttribute('aria-description', hoverDescription);
      context.font = '12px system-ui';
      const padding = 9;
      const lineHeight = 17;
      const boxWidth =
        Math.max(...lines.map((line) => context.measureText(line).width)) + padding * 2;
      const boxHeight = lines.length * lineHeight + padding * 2;
      const preferredY = screenPoint.y - boxHeight - 18;
      const boxX = Math.max(8, Math.min(width - boxWidth - 8, screenPoint.x + 18));
      const boxY =
        preferredY >= 8 ? preferredY : Math.min(height - boxHeight - 8, screenPoint.y + 18);
      context.fillStyle = 'rgba(12, 20, 32, 0.96)';
      context.strokeStyle = '#86a997';
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(boxX, boxY, boxWidth, boxHeight, 5);
      context.fill();
      context.stroke();
      lines.forEach((line, index) => {
        context.font = index === 0 ? 'bold 12px system-ui' : '12px system-ui';
        context.fillStyle = index === lines.length - 1 ? '#d9c27a' : '#f4f0df';
        context.fillText(line, boxX + padding, boxY + padding + lineHeight * (index + 0.78));
      });
    } else if (element.hasAttribute('aria-description'))
      element.removeAttribute('aria-description');
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
        const renderedTiles =
          (metricsBounds.maxX - metricsBounds.minX + 1) *
          (metricsBounds.maxY - metricsBounds.minY + 1);
        const visibleBuildings = visibleByIsometricDepth(
          latestBuildings.current,
          metricsBounds.center,
          metricsRadius,
        ).length;
        const visibleThreats = visibleByIsometricDepth(
          latestThreats.current,
          metricsBounds.center,
          metricsRadius,
        ).length;
        latestMetrics.current?.({
          framesPerSecond: Math.round((renderedFrames * 1_000) / elapsed),
          renderedTiles,
          visibleBuildings,
          visibleThreats,
          activeChunks: chunks.size,
          renderObjectCount: renderedTiles + visibleBuildings + visibleThreats,
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
      const origin = cameraOrigin(rectangle.width, rectangle.height);
      const focus = latestFocus.current;
      const point = {
        x: (event.clientX - rectangle.left - origin.x - view.panX) / view.scale,
        y: (event.clientY - rectangle.top - origin.y - view.panY) / view.scale,
      };
      const flat = screenToTile(point);
      const groundTile = { x: flat.x + focus.x, y: flat.y + focus.y };
      /**
       * A mountain accepts no command, so rock standing in front of an entity must not
       * swallow the click: when the ground tile under the pointer is occupied, that entity
       * wins. Nothing is lost for the mountain and players keep access to their buildings.
       */
      if (entityAtTile(groundTile, latestBuildings.current, latestThreats.current))
        return groundTile;
      // Picking runs in focus-relative tile space, so the elevation lookup shifts too.
      const raised = screenToRaisedTile(
        point,
        (x, y) => latestElevation.current[`${x + focus.x}:${y + focus.y}`] ?? 0,
        MAX_ELEVATION,
      );
      return { x: raised.x + focus.x, y: raised.y + focus.y };
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
