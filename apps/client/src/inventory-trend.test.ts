import { describe, expect, it } from 'vitest';
import {
  inventoryRatesPerMinute,
  withInventorySample,
  TREND_WINDOW_MS,
  type InventorySample,
} from './inventory-trend.js';

const stock = (ore: number, wood = 0): InventorySample['inventory'] => ({
  ore,
  wood,
  stone: 0,
  ingot: 0,
  brick: 0,
  tool: 0,
  steel: 0,
});

describe('inventory trend', () => {
  it('drops samples that have left the window', () => {
    const samples = [
      { at: 0, inventory: stock(0) },
      { at: 30_000, inventory: stock(5) },
    ];
    const rolled = withInventorySample(samples, { at: TREND_WINDOW_MS + 1, inventory: stock(9) });
    expect(rolled.map((sample) => sample.at)).toEqual([30_000, TREND_WINDOW_MS + 1]);
  });

  it('reports change per minute across the window', () => {
    expect(
      inventoryRatesPerMinute([
        { at: 0, inventory: stock(2, 10) },
        { at: 30_000, inventory: stock(8, 4) },
      ]),
    ).toMatchObject({ ore: 12, wood: -12 });
  });

  it('reports no rate until the window is long enough to be meaningful', () => {
    expect(inventoryRatesPerMinute([])).toEqual({});
    expect(inventoryRatesPerMinute([{ at: 0, inventory: stock(1) }])).toEqual({});
    expect(
      inventoryRatesPerMinute([
        { at: 0, inventory: stock(0) },
        { at: 2_000, inventory: stock(1) },
      ]),
    ).toEqual({});
  });
});
