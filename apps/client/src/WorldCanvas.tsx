import { Application, Graphics } from 'pixi.js';
import { useEffect, useRef } from 'react';
import { TILE_HEIGHT, TILE_WIDTH, worldToScreen } from './projection.js';

export const WorldCanvas = () => {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const app = new Application();
    let disposed = false;
    void app.init({ resizeTo: host.current ?? window, background: '#17243a', antialias: true }).then(() => {
      if (!host.current || disposed) return;
      host.current.replaceChildren(app.canvas);
      for (let x = -8; x <= 8; x += 1) for (let y = -8; y <= 8; y += 1) {
        const position = worldToScreen({ x, y });
        const tile = new Graphics().poly([0, TILE_HEIGHT / 2, TILE_WIDTH / 2, 0, TILE_WIDTH, TILE_HEIGHT / 2, TILE_WIDTH / 2, TILE_HEIGHT]).fill({ color: (x + y) % 2 === 0 ? '#3b6a48' : '#315d3d' });
        tile.position.set(position.x + app.renderer.width / 2 - TILE_WIDTH / 2, position.y + 80);
        app.stage.addChild(tile);
      }
    });
    return () => { disposed = true; app.destroy(); };
  }, []);
  return <div className="world-canvas" ref={host} aria-label="Isometric world map" />;
};
