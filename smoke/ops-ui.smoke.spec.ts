import { expect, test } from '@playwright/test';

test.use({
  channel: 'msedge',
  headless: true,
  viewport: { width: 1600, height: 1100 },
});

test('loads the ROBIN shell and switches between top-level tabs', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded' });

  const mapTab = page.locator('.ops-tab').filter({ hasText: 'Map Overview' });
  const statusTab = page.locator('.ops-tab').filter({ hasText: 'Status Overview' });
  const agentTab = page.locator('.ops-tab').filter({ hasText: 'Agent' });

  await expect(page.getByText('ROBIN').first()).toBeVisible();
  await expect(mapTab).toBeVisible();
  await expect(statusTab).toBeVisible();
  await expect(agentTab).toBeVisible();

  // In the current smoke environment the gateway is offline, so the shell should
  // degrade cleanly instead of failing to render.
  await expect(page.getByText(/Central agent unavailable:/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry sync/i })).toBeVisible();
  await expect(page.locator('.ops-chat-form button[type="submit"]')).toBeDisabled();

  await page.screenshot({
    path: '.smoke-ops-home.png',
    fullPage: true,
  });

  await statusTab.click();
  await expect(page.getByText('Status Overview')).toBeVisible();

  await page.screenshot({
    path: '.smoke-ops-status.png',
    fullPage: true,
  });

  await agentTab.click();
  await expect(page.getByText('Support Shell')).toBeVisible();

  await page.screenshot({
    path: '.smoke-ops-terminals.png',
    fullPage: true,
  });

  await mapTab.click();
  await expect(page.getByText('Map Overview')).toBeVisible();

  await page.screenshot({
    path: '.smoke-ops-map.png',
    fullPage: true,
  });
});
