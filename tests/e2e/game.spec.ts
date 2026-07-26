import { expect, test, type Page } from '@playwright/test';

const selectCanvasTile = async (page: Page, expectedText: RegExp) => {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  for (let y = 30; y < bounds.height - 20; y += 36)
    for (let x = 30; x < bounds.width - 20; x += 36) {
      await canvas.dispatchEvent('pointerup', {
        clientX: bounds.x + x,
        clientY: bounds.y + y,
        pointerId: 1,
      });
      if (expectedText.test(await page.locator('body').innerText())) return;
    }
  throw new Error(`Could not find a canvas tile matching ${String(expectedText)}`);
};

const inventory = async (page: Page) => {
  const text = await page
    .locator('aside.hud p')
    .filter({ hasText: /^Ore \d+/ })
    .first()
    .innerText();
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
  for (let y = 30; y < bounds.height - 20; y += 36)
    for (let x = 30; x < bounds.width - 20; x += 36) {
      await canvas.dispatchEvent('pointerup', {
        clientX: bounds.x + x,
        clientY: bounds.y + y,
        pointerId: 1,
      });
      if (!selected.test(await page.locator('body').innerText())) continue;
      const before = (await inventory(page))[resource];
      await page.getByRole('button', { name: `Gather ${resource}` }).click();
      await page.waitForTimeout(300);
      if ((await inventory(page))[resource] > before) return;
    }
  throw new Error(`Could not gather an available ${resource} deposit`);
};

const gatherTo = async (page: Page, resource: 'ore' | 'wood', minimum: number) => {
  if ((await inventory(page))[resource] >= minimum) return;
  await gatherResource(page, resource);
  while ((await inventory(page))[resource] < minimum) {
    const before = (await inventory(page))[resource];
    await page.getByRole('button', { name: `Gather ${resource}` }).click();
    await page.waitForTimeout(300);
    if ((await inventory(page))[resource] === before) await gatherResource(page, resource);
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
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  const canvas = page.locator('canvas');
  await expect(canvas).toHaveAttribute('aria-label', /isometric world map/i);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('World canvas has no visible bounds');
  await canvas.dispatchEvent('pointerup', {
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
    pointerId: 1,
  });
  await expect(page.getByText('Selected building: settlement-center')).toBeVisible();
  await expect(page.getByText(/Next: Gather ore and wood/)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  await page.keyboard.press('Control+Equal');
  await expect(page.getByRole('heading', { name: 'Settlement needs' })).toBeVisible();
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

  await page.getByRole('button', { name: /Research Metallurgy/ }).click();
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
