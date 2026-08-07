import { expect, test, type Locator, type Page } from '@playwright/test';

const canvasProbePositions = (width: number, height: number) => {
  const positions: Array<{ x: number; y: number }> = [];
  for (let y = 30; y < height - 20; y += 36)
    for (let x = 30; x < width - 20; x += 36) positions.push({ x, y });
  return positions.sort(
    (left, right) =>
      (left.x - width / 2) ** 2 +
      (left.y - height / 2) ** 2 -
      ((right.x - width / 2) ** 2 + (right.y - height / 2) ** 2),
  );
};

const canvasBounds = async (page: Page) => {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  return bounds;
};

const clickCanvas = async (
  page: Page,
  bounds: { x: number; y: number },
  position: { x: number; y: number },
) =>
  page.locator('canvas').dispatchEvent('pointerup', {
    clientX: bounds.x + position.x,
    clientY: bounds.y + position.y,
    pointerId: 1,
  });

/** Selects tiles until the HUD reports the expected state, and returns the tile that did. */
const selectCanvasTile = async (page: Page, expectedText: RegExp) => {
  const bounds = await canvasBounds(page);
  for (const position of canvasProbePositions(bounds.width, bounds.height)) {
    await clickCanvas(page, bounds, position);
    if (expectedText.test(await page.locator('body').innerText())) return position;
  }
  throw new Error(`Could not find a canvas tile matching ${String(expectedText)}`);
};

/**
 * Placement is two steps: the menu arms a building, then a click on the map puts it there.
 * The tile is chosen first so the click lands on a site the HUD has already called buildable.
 */
const placeBuilding = async (page: Page, name: RegExp) => {
  const position = await selectCanvasTile(page, /Selected tile is buildable/);
  const place = page.getByRole('button', { name });
  await expect(place).toBeEnabled({ timeout: 10_000 });
  await place.click();
  await expect(place).toHaveAttribute('aria-pressed', 'true');
  await clickCanvas(page, await canvasBounds(page), position);
};

const openHudTab = async (
  page: Page,
  tab: 'build' | 'settlement' | 'world' | 'coop' | 'settings',
) => {
  await page.locator(`#hud-tab-${tab}`).click();
  await expect(page.locator(`#hud-panel-${tab}`)).toBeVisible();
};

/** Reads the header resource bar, which carries one chip per carryable item. */
const inventory = async (page: Page) => {
  const required = ['ore', 'wood', 'stone', 'ingot', 'brick', 'tool'] as const;
  const amounts = await Promise.all(
    required.map(async (item) => {
      const chip = page.locator(`.game-topbar .resource-bar [data-item="${item}"]`).first();
      const amount = await chip.getAttribute('data-amount');
      if (amount === null) throw new Error(`The resource bar has no chip for ${item}`);
      return [item, Number(amount)] as const;
    }),
  );
  return Object.fromEntries(amounts) as Record<(typeof required)[number], number>;
};

/**
 * Building rows are the master list. Activating one opens its controls in the inspector.
 */
const inspectBuilding = async (page: Page, building: Locator) => {
  const summary = building.locator('button.building-summary');
  if ((await summary.getAttribute('aria-pressed')) !== 'true') await summary.click();
  await expect(summary).toHaveAttribute('aria-pressed', 'true');
  const inspector = page.locator('.context-inspector');
  await expect(inspector).toBeVisible();
  return inspector;
};

const openBuilding = async (page: Page, kind: string) => {
  const building = page.locator('section.building').filter({ hasText: kind }).first();
  await expect(building).toBeVisible();
  return inspectBuilding(page, building);
};

const gatherResource = async (page: Page, resource: 'ore' | 'wood') => {
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  const selected = resource === 'ore' ? /Resource: Ore deposit/ : /Resource: Timber grove/;
  for (const position of canvasProbePositions(bounds.width, bounds.height)) {
    await canvas.dispatchEvent('pointerup', {
      clientX: bounds.x + position.x,
      clientY: bounds.y + position.y,
      pointerId: 1,
    });
    if (!selected.test(await page.locator('body').innerText())) continue;
    const before = (await inventory(page))[resource];
    await page.getByRole('button', { name: `Gather ${resource}` }).click();
    await page.waitForTimeout(300);
    if ((await inventory(page))[resource] > before) {
      await expect(canvas).toHaveAttribute(
        'aria-description',
        new RegExp(`${resource} remaining: \\d+/10.*Reachable for gathering`),
      );
      return;
    }
  }
  throw new Error(`Could not gather an available ${resource} deposit`);
};

const gatherTo = async (page: Page, resource: 'ore' | 'wood', minimum: number) => {
  if ((await inventory(page))[resource] >= minimum) return;
  await gatherResource(page, resource);
  const canvas = page.locator('canvas');
  while ((await inventory(page))[resource] < minimum) {
    const before = (await inventory(page))[resource];
    const remainingBefore = Number(
      (await canvas.getAttribute('aria-description'))?.match(
        new RegExp(`${resource} remaining: (\\d+)/10`),
      )?.[1],
    );
    await page.getByRole('button', { name: `Gather ${resource}` }).click();
    await page.waitForTimeout(300);
    if ((await inventory(page))[resource] === before) await gatherResource(page, resource);
    else
      await expect(canvas).toHaveAttribute(
        'aria-description',
        new RegExp(`${resource} remaining: ${remainingBefore - 1}/10`),
      );
  }
};

const completedBuilding = async (page: Page, kind: string) => {
  const building = page.locator('section.building').filter({ hasText: kind }).first();
  await expect(building).toBeVisible();
  // The row states its own status, so completion is visible without opening anything.
  await expect(building.getByText('Under construction')).toHaveCount(0, { timeout: 10_000 });
  return inspectBuilding(page, building);
};

test('loads onboarding accessibly at the supported viewport and input surface', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('Connected');
  // The header keeps identity, connection, resources, and the next step visible on every tab.
  await expect(page.locator('.game-topbar .resource-bar')).toContainText(/Ore \d+/);
  await expect(page.locator('.game-topbar .onboarding-next')).toContainText('Next objective');
  await expect(page.locator('#hud-tab-build')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Construction' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Default map layer' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Bottlenecks map layer' }).click();
  await expect(page.getByRole('button', { name: 'Bottlenecks map layer' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const canvas = page.locator('canvas');
  await expect(canvas).toHaveAttribute('aria-label', /isometric world map/i);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  await canvas.dispatchEvent('pointerup', {
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
    pointerId: 1,
  });
  await expect(page.locator('.context-inspector')).toContainText('Settlement center');
  await canvas.hover({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(canvas).toHaveAttribute(
    'aria-description',
    /Tile .*(Grassland|Timber grove|Ore deposit).*Your territory.*settlement center.*Not buildable/,
  );
  await expect(page.locator('.game-topbar .onboarding-next')).toContainText('Gather ore and wood');
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(page.locator('.context-inspector')).toHaveCount(0);
  await page.keyboard.press('Control+Equal');

  // Tabs are reachable with the keyboard and only the selected panel is exposed.
  await page.locator('#hud-tab-build').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#hud-tab-settlement')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Settlement needs' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  await expect(page.locator('#hud-panel-build')).toBeHidden();
  await page.keyboard.press('End');
  await expect(page.locator('#hud-tab-settings')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Accessibility and controls' })).toBeVisible();
  await openHudTab(page, 'build');
});

test('completes the authoritative gather-build-produce-research-defend loop', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'Critical loop runs once; smoke runs in every engine.',
  );
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('Connected');

  await gatherTo(page, 'ore', 2);
  await gatherTo(page, 'wood', 11);

  await placeBuilding(page, /Place smelter/);
  let smelter = await completedBuilding(page, 'Smelter');
  await smelter.getByRole('button', { name: 'Load 1 ore' }).click();
  await expect(smelter.getByRole('button', { name: 'Take 1 ingot' })).toBeEnabled();
  await smelter.getByRole('button', { name: 'Take 1 ingot' }).click();

  await openHudTab(page, 'settlement');
  await page.getByRole('button', { name: /Research Metallurgy/ }).click();
  await openHudTab(page, 'build');
  await placeBuilding(page, /Place workshop/);
  await completedBuilding(page, 'Workshop');

  smelter = await openBuilding(page, 'Smelter');
  await smelter.getByRole('button', { name: 'Load 1 ore' }).click();
  await expect(smelter.getByRole('button', { name: 'Take 1 ingot' })).toBeEnabled();
  await smelter.getByRole('button', { name: 'Take 1 ingot' }).click();
  await smelter.getByRole('combobox', { name: 'Job priority' }).selectOption('0');
  const workshop = await openBuilding(page, 'Workshop');
  await workshop.getByRole('button', { name: 'Load 1 ingot' }).click();
  await workshop.getByRole('button', { name: 'Load 1 wood' }).click();
  await expect(workshop.getByRole('button', { name: 'Take 1 tool' })).toBeEnabled();
  await workshop.getByRole('button', { name: 'Take 1 tool' }).click();
  await workshop.getByRole('combobox', { name: 'Job priority' }).selectOption('0');

  await placeBuilding(page, /Place watchtower/);
  await completedBuilding(page, 'Watchtower');

  // A damaged building says so on its own row, before it is opened.
  const damaged = page.locator('section.building').filter({ hasText: 'Damaged' }).first();
  await expect(damaged).toBeVisible({ timeout: 45_000 });
  const damagedName = await damaged.locator('.building-name').innerText();
  const damagedInspector = await inspectBuilding(page, damaged);
  await expect(damagedInspector.getByText('Damaged by a threat or acid rain')).toBeVisible();
  await damagedInspector.getByRole('button', { name: 'Repair' }).click();
  await expect(
    page
      .locator('section.building')
      .filter({ hasText: damagedName })
      .locator('.building-state.damaged'),
  ).toHaveCount(0);
});

test('automates gathering with a lumber camp beside a timber grove', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'Automation runs once; smoke runs in every engine.',
  );
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('Connected');

  const place = page.getByRole('button', { name: /Place lumber camp/ });
  await expect(page.getByText(/Extracts 1 wood every \d+ ticks while staffed/)).toBeVisible();
  await place.click();
  await expect(place).toHaveAttribute('aria-pressed', 'true');

  /*
   * An extractor needs a grove in range, and the armed camp simply refuses a site that has
   * none, so probing with the camp armed is the same check the map makes: the first click
   * that produces a camp found a working site.
   */
  const bounds = await canvasBounds(page);
  const camps = page.locator('section.building').filter({ hasText: 'Lumber camp' });
  let site = false;
  for (const position of canvasProbePositions(bounds.width, bounds.height)) {
    await clickCanvas(page, bounds, position);
    await page.waitForTimeout(250);
    if ((await camps.count()) > 0) {
      site = true;
      break;
    }
  }
  if (!site) throw new Error('No lumber camp site was accepted inside the starter plot');

  const camp = await completedBuilding(page, 'Lumber camp');
  await expect(camp.getByText(/Extraction: \d+\/\d+ ticks per wood/)).toBeVisible();
  // No gather command is sent here: the camp works the grove on its own.
  await expect(camp.getByText(/Inventory: ore 0 · wood [1-9]/)).toBeVisible({ timeout: 30_000 });
});

test('arms a building for placement with its hotkey and cancels with Escape', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'Placement mode runs once; smoke runs in every engine.',
  );
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('Connected');

  const place = page.getByRole('button', { name: /Place storage/ });
  await expect(place).toHaveAttribute('aria-keyshortcuts', '6');
  await expect(place).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('6');
  await expect(place).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Placing storage/)).toBeVisible();

  // The map answers for the armed building rather than for buildability in general.
  const bounds = await canvasBounds(page);
  await page.locator('canvas').hover({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(page.locator('canvas')).toHaveAttribute(
    'aria-description',
    /(Place storage here|Cannot place storage:)/,
  );

  await page.keyboard.press('Escape');
  await expect(place).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText(/Placing storage/)).toHaveCount(0);
});
