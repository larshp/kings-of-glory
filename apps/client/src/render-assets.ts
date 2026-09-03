/**
 * Sprites are authored in 64x64 design cells and stored at a 2x source resolution, so
 * one design pixel maps to one logical pixel while staying crisp on high-density
 * displays. New sprites must be added here before the canvas can use them, must use a
 * ground-contact origin, and must keep the atlas on the 64-design-pixel grid.
 */
export const spriteAtlasManifest = {
  world: { url: '/assets/world-atlas.svg', width: 640, height: 768, sourceScale: 2 },
} as const;

export type SpriteId =
  | 'settlement-center'
  | 'smelter'
  | 'workshop'
  | 'storage'
  | 'housing'
  | 'hearth'
  | 'watchtower'
  | 'mine'
  | 'lumber-camp'
  | 'forester'
  | 'quarry'
  | 'brickworks'
  | 'wall'
  | 'foundry'
  | 'bastion'
  | 'guild-hall'
  | 'construction'
  | 'raider'
  | 'carrier'
  | 'selection'
  | 'ore-node'
  | 'ore-node-low'
  | 'ore-node-spent'
  | 'timber-node'
  | 'timber-node-low'
  | 'timber-node-spent'
  | 'stone-node'
  | 'stone-node-low'
  | 'stone-node-spent';

export interface SpriteFrame {
  readonly atlas: keyof typeof spriteAtlasManifest;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
}

const CELL = 64;
const SOURCE_SCALE = spriteAtlasManifest.world.sourceScale;

/**
 * `originY` is the design-space row that meets the ground. Buildings and ground clutter
 * share the base-diamond centre at 52; markers that must cover a whole tile use 32.
 */
const frame = (column: number, row: number, originY = 52): SpriteFrame => ({
  atlas: 'world',
  x: column * CELL * SOURCE_SCALE,
  y: row * CELL * SOURCE_SCALE,
  width: CELL * SOURCE_SCALE,
  height: CELL * SOURCE_SCALE,
  originX: (CELL / 2) * SOURCE_SCALE,
  originY: originY * SOURCE_SCALE,
});

export const spriteFrames: Readonly<Record<SpriteId, SpriteFrame>> = {
  'settlement-center': frame(0, 0),
  smelter: frame(1, 0),
  workshop: frame(2, 0),
  storage: frame(3, 0),
  housing: frame(4, 0),
  hearth: frame(0, 1),
  watchtower: frame(1, 1),
  mine: frame(2, 1),
  'lumber-camp': frame(3, 1),
  forester: frame(3, 1),
  construction: frame(4, 1),
  raider: frame(0, 2),
  selection: frame(1, 2, 32),
  'ore-node': frame(2, 2),
  'ore-node-low': frame(3, 2),
  'ore-node-spent': frame(4, 2),
  'timber-node': frame(0, 3),
  'timber-node-low': frame(1, 3),
  'timber-node-spent': frame(2, 3),
  quarry: frame(3, 3),
  brickworks: frame(4, 3),
  wall: frame(0, 4),
  carrier: frame(1, 4),
  'stone-node': frame(2, 4),
  'stone-node-low': frame(3, 4),
  'stone-node-spent': frame(4, 4),
  foundry: frame(0, 5),
  bastion: frame(1, 5),
  'guild-hall': frame(2, 5),
};

export type RenderAssets = Readonly<Record<keyof typeof spriteAtlasManifest, HTMLImageElement>>;

export const loadRenderAssets = (
  onProgress: (loaded: number, total: number) => void,
): Promise<RenderAssets> => {
  const entries = Object.entries(spriteAtlasManifest) as Array<
    [
      keyof typeof spriteAtlasManifest,
      (typeof spriteAtlasManifest)[keyof typeof spriteAtlasManifest],
    ]
  >;
  let loaded = 0;
  onProgress(loaded, entries.length);
  return Promise.all(
    entries.map(
      ([name, asset]) =>
        new Promise<readonly [keyof typeof spriteAtlasManifest, HTMLImageElement]>(
          (resolve, reject) => {
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => {
              loaded += 1;
              onProgress(loaded, entries.length);
              resolve([name, image]);
            };
            image.onerror = () => reject(new Error(`Could not load renderer asset: ${asset.url}`));
            image.src = asset.url;
          },
        ),
    ),
  ).then((images) => Object.fromEntries(images) as RenderAssets);
};

/** Draws an atlas frame at its documented ground origin, in design-pixel units. */
export const drawSprite = (
  context: CanvasRenderingContext2D,
  assets: RenderAssets,
  sprite: SpriteId,
  worldX: number,
  worldY: number,
  opacity = 1,
) => {
  const source = spriteFrames[sprite];
  const scale = spriteAtlasManifest[source.atlas].sourceScale;
  const previousAlpha = context.globalAlpha;
  if (opacity !== 1) context.globalAlpha = previousAlpha * opacity;
  context.drawImage(
    assets[source.atlas],
    source.x,
    source.y,
    source.width,
    source.height,
    worldX - source.originX / scale,
    worldY - source.originY / scale,
    source.width / scale,
    source.height / scale,
  );
  context.globalAlpha = previousAlpha;
};
