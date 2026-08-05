import { ItemIcon } from './ItemIcon.js';
import { itemLabel, ITEM_KINDS } from './labels.js';
import type { ItemKind } from './types.js';

export interface ResourceBarProps {
  readonly inventory: Readonly<Record<ItemKind, number>>;
  /** Change per minute over the last window; a missing or zero entry shows no trend. */
  readonly rates: Readonly<Partial<Record<ItemKind, number>>>;
}

/**
 * What the player is carrying, as one chip per item instead of a single joined sentence. The
 * trend is what makes the bar worth reading during play: it answers whether a chain is
 * running without opening a panel, which the raw count never could.
 */
export const ResourceBar = ({ inventory, rates }: ResourceBarProps) => (
  <ul aria-label="Carried resources" className="resource-bar">
    {ITEM_KINDS.map((item) => {
      const rate = rates[item] ?? 0;
      return (
        <li
          className="resource-chip"
          data-amount={inventory[item]}
          data-item={item}
          key={item}
          title={
            rate === 0
              ? `${itemLabel(item)}: ${inventory[item]} carried`
              : `${itemLabel(item)}: ${inventory[item]} carried, ${rate > 0 ? '+' : ''}${rate} per minute`
          }
        >
          <ItemIcon item={item} />
          {/* The explicit space keeps the chip readable as "Ore 12" in text and to a reader. */}
          <span className="resource-name">{itemLabel(item)}</span>{' '}
          <span className="resource-amount">{inventory[item]}</span>
          {rate !== 0 && (
            <span className={rate > 0 ? 'resource-rate rising' : 'resource-rate falling'}>
              <span aria-hidden="true">
                {rate > 0 ? '▲' : '▼'}
                {Math.abs(rate)}
              </span>
              <span className="visually-hidden">
                {rate > 0 ? 'up' : 'down'} {Math.abs(rate)} per minute
              </span>
            </span>
          )}
        </li>
      );
    })}
  </ul>
);
