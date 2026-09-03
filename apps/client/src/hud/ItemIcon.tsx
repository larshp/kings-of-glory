import type { ItemKind } from './types.js';

/**
 * Small item glyphs for the HUD. They are inline SVG rather than atlas frames because the
 * atlas is authored for the isometric world at a ground-contact origin, and because every
 * glyph has to stay legible at one line of text. Each item differs in silhouette as well as
 * colour, so the bar never depends on colour alone to tell two resources apart.
 */
const glyphs: Readonly<Record<ItemKind, { readonly fill: string; readonly path: string }>> = {
  ore: { fill: '#9fbcff', path: 'M2 12l3-6 4 2 2-4 3 8z' },
  wood: { fill: '#b98a52', path: 'M2 5h12v6H2zM5 5v6M9 5v6' },
  stone: { fill: '#cdd6e2', path: 'M3 4h7l3 3v5H3z' },
  ingot: { fill: '#f0c060', path: 'M4 6h8l2 5H2z' },
  brick: { fill: '#c9714f', path: 'M2 4h12v4H2zM2 9h5v4H2zM8 9h6v4H8z' },
  tool: { fill: '#d7e6f3', path: 'M3 13l6-6 2 2-6 6zM9 3h5v3h-5z' },
  steel: { fill: '#8fa3b8', path: 'M2 3h12v2H2zM7 5h2v6H7zM2 11h12v2H2z' },
};

export const ItemIcon = ({ item }: { readonly item: ItemKind }) => {
  const glyph = glyphs[item];
  return (
    <svg
      aria-hidden="true"
      className="item-icon"
      focusable="false"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d={glyph.path}
        fill={item === 'wood' ? 'none' : glyph.fill}
        stroke={glyph.fill}
        strokeLinejoin="round"
        strokeWidth={item === 'wood' ? 1.5 : 1}
      />
    </svg>
  );
};
