import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node apps/server/dist/index.js',
      url: 'http://127.0.0.1:3001/ready',
      env: { PEACEFUL: 'false', PERSISTENCE: 'memory', TICK_INTERVAL_MS: '100' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
      cwd: 'apps/client',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'firefox-minimum',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1024, height: 768 } },
    },
    {
      name: 'webkit-minimum',
      use: { ...devices['Desktop Safari'], viewport: { width: 1024, height: 768 } },
    },
  ],
});
