/**
 * The renderer uses one logical pixel per atlas pixel at a 2x source resolution.
 * New sprites must be 64x64 pixels, use a bottom-centre origin, and be added here
 * before they can be used by the canvas.  Keeping the map in one atlas avoids a
 * network request per building or effect and makes the loading screen truthful.
 */
export const spriteAtlasManifest = {
  world: { url: '/assets/world-atlas.svg', width: 256, height: 192 },
} as const;

export type SpriteId =
  | 'settlement-center'
  | 'smelter'
  | 'workshop'
  | 'storage'
  | 'housing'
  | 'hearth'
  | 'watchtower'
  | 'construction'
  | 'raider'
  | 'selection';

export interface SpriteFrame {
  readonly atlas: keyof typeof spriteAtlasManifest;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
}

const frame = (x: number, y: number): SpriteFrame => ({
  atlas: 'world',
  x,
  y,
  width: 64,
  height: 64,
  originX: 32,
  originY: 52,
});

export const spriteFrames: Readonly<Record<SpriteId, SpriteFrame>> = {
  'settlement-center': frame(0, 0),
  smelter: frame(64, 0),
  workshop: frame(128, 0),
  storage: frame(192, 0),
  housing: frame(0, 64),
  hearth: frame(64, 64),
  watchtower: frame(128, 64),
  construction: frame(192, 64),
  raider: frame(0, 128),
  selection: frame(64, 128),
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

/** Draws an atlas frame at its documented bottom-centre world origin. */
export const drawSprite = (
  context: CanvasRenderingContext2D,
  assets: RenderAssets,
  sprite: SpriteId,
  worldX: number,
  worldY: number,
) => {
  const source = spriteFrames[sprite];
  context.drawImage(
    assets[source.atlas],
    source.x,
    source.y,
    source.width,
    source.height,
    worldX - source.originX,
    worldY - source.originY,
    source.width,
    source.height,
  );
};
