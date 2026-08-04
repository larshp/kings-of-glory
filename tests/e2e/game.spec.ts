import { expect, test, type Page } from '@playwright/test';

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

const selectCanvasTile = async (page: Page, expectedText: RegExp) => {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  for (const position of canvasProbePositions(bounds.width, bounds.height)) {
    await canvas.dispatchEvent('pointerup', {
      clientX: bounds.x + position.x,
      clientY: bounds.y + position.y,
      pointerId: 1,
    });
    if (expectedText.test(await page.locator('body').innerText())) return;
  }
  throw new Error(`Could not find a canvas tile matching ${String(expectedText)}`);
};

const openHudTab = async (
  page: Page,
  tab: 'build' | 'settlement' | 'world' | 'coop' | 'settings',
) => {
  await page.locator(`#hud-tab-${tab}`).click();
  await expect(page.locator(`#hud-panel-${tab}`)).toBeVisible();
};

const inventory = async (page: Page) => {
  const text = await page.locator('aside.hud p.resource-bar').first().innerText();
  const values = text.match(/^Ore (\d+) .* Wood (\d+) .* Ingot (\d+) .* Tool (\d+)$/);
  if (!values) throw new Error(`Could not parse inventory summary: ${text}`);
  return {
    ore: Number(values[1]),
    wood: Number(values[2]),
    ingot: Number(values[3]),
    tool: Number(values[4]),
  };
};

const gatherResource = async (page: Page, resource: 'ore' | 'wood') => {
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  const selected = resource === 'ore' ? /\(ore deposit\)/ : /\(timber grove\)/;
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
        /Resource remaining: \d+\/10.*Reachable for gathering/,
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
      (await canvas.getAttribute('aria-description'))?.match(/Resource remaining: (\d+)\/10/)?.[1],
    );
    await page.getByRole('button', { name: `Gather ${resource}` }).click();
    await page.waitForTimeout(300);
    if ((await inventory(page))[resource] === before) await gatherResource(page, resource);
    else
      await expect(canvas).toHaveAttribute(
        'aria-description',
        new RegExp(`Resource remaining: ${remainingBefore - 1}/10`),
      );
  }
};

const completedBuilding = async (page: Page, kind: string) => {
  const building = page.locator('section.building').filter({ hasText: kind }).first();
  await expect(building).toBeVisible();
  await expect(building.getByText(/Construction:/)).toHaveCount(0, { timeout: 10_000 });
  return building;
};

test('loads onboarding accessibly at the supported viewport and input surface', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('Connected');
  // The header keeps identity, connection, resources, and the next step visible on every tab.
  await expect(page.locator('.hud-header .resource-bar')).toContainText(/Ore \d+/);
  await expect(page.locator('.hud-header .onboarding-next')).toContainText('Next:');
  await expect(page.locator('#hud-tab-build')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Construction' })).toBeVisible();
  const canvas = page.locator('canvas');
  await expect(canvas).toHaveAttribute('aria-label', /isometric world map/i);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  await canvas.dispatchEvent('pointerup', {
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
    pointerId: 1,
  });
  await expect(page.getByText('Selected building: Settlement center')).toBeVisible();
  await canvas.hover({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(canvas).toHaveAttribute(
    'aria-description',
    /Tile .*(Grassland|Timber grove|Ore deposit).*Your territory.*settlement center.*Not buildable/,
  );
  await expect(page.getByText(/Next: Gather ore and wood/)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
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

  await selectCanvasTile(page, /Selected tile is buildable/);
  await page.getByRole('button', { name: /Place smelter/ }).click();
  const smelter = await completedBuilding(page, 'smelter');
  await smelter.getByRole('button', { name: 'Load 1 ore' }).click();
  await expect(smelter.getByRole('button', { name: 'Take 1 ingot' })).toBeEnabled();
  await smelter.getByRole('button', { name: 'Take 1 ingot' }).click();

  await openHudTab(page, 'settlement');
  await page.getByRole('button', { name: /Research Metallurgy/ }).click();
  await openHudTab(page, 'build');
  await selectCanvasTile(page, /Selected tile is buildable/);
  await expect(page.getByRole('button', { name: /Place workshop/ })).toBeEnabled({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: /Place workshop/ }).click();
  const workshop = await completedBuilding(page, 'workshop');

  await smelter.getByRole('button', { name: 'Load 1 ore' }).click();
  await expect(smelter.getByRole('button', { name: 'Take 1 ingot' })).toBeEnabled();
  await smelter.getByRole('button', { name: 'Take 1 ingot' }).click();
  await workshop.getByRole('button', { name: 'Load 1 ingot' }).click();
  await workshop.getByRole('button', { name: 'Load 1 wood' }).click();
  await expect(workshop.getByRole('button', { name: 'Take 1 tool' })).toBeEnabled();
  await workshop.getByRole('button', { name: 'Take 1 tool' }).click();
  await smelter.getByRole('combobox', { name: 'Job priority' }).selectOption('0');
  await workshop.getByRole('combobox', { name: 'Job priority' }).selectOption('0');

  await selectCanvasTile(page, /Selected tile is buildable/);
  await page.getByRole('button', { name: /Place watchtower/ }).click();
  await completedBuilding(page, 'watchtower');

  const damaged = page
    .locator('section.building')
    .filter({ hasText: 'Damaged by a threat or acid rain' })
    .first();
  await expect(damaged).toBeVisible({ timeout: 45_000 });
  await damaged.getByRole('button', { name: 'Repair' }).click();
  await expect(damaged.getByText('Damaged by a threat or acid rain')).toHaveCount(0);
});

test('automates gathering with a lumber camp beside a timber grove', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'Automation runs once; smoke runs in every engine.',
  );
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('Connected');

  // Extractors need a deposit in range, so probe tiles until the build menu enables one.
  const place = page.getByRole('button', { name: /Place lumber camp/ });
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  let site = false;
  for (const position of canvasProbePositions(bounds.width, bounds.height)) {
    await canvas.dispatchEvent('pointerup', {
      clientX: bounds.x + position.x,
      clientY: bounds.y + position.y,
      pointerId: 1,
    });
    if (await place.isEnabled()) {
      site = true;
      break;
    }
  }
  if (!site) throw new Error('No lumber camp site was offered inside the starter plot');
  await expect(page.getByText(/Extracts 1 wood every \d+ ticks while staffed/)).toBeVisible();
  await place.click();

  const camp = await completedBuilding(page, 'Lumber camp');
  await expect(camp.getByText(/Extraction: \d+\/\d+ ticks per wood/)).toBeVisible();
  // No gather command is sent here: the camp works the grove on its own.
  await expect(camp.getByText(/Inventory: ore 0 · wood [1-9]/)).toBeVisible({ timeout: 30_000 });
});
