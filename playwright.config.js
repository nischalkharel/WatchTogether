import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3123;
export const OFFLINE_PORT = 3125;

// On machines without the browser's system libraries, `scripts-e2e/fetch-libs.mjs`
// downloads them into .e2e-env (nothing is installed system-wide).
const extra = path.resolve('.e2e-env/root');
const libs = [`${extra}/usr/lib/x86_64-linux-gnu`, `${extra}/lib/x86_64-linux-gnu`].join(':');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: {
      args: ['--disable-dev-shm-usage'],
      env: fs.existsSync(extra)
        ? {
            ...process.env,
            LD_LIBRARY_PATH: `${libs}:${process.env.LD_LIBRARY_PATH || ''}`,
            FONTCONFIG_FILE: path.resolve('.e2e-env/fonts.conf'),
          }
        : process.env,
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'iphone',
      // Chromium emulating an iPhone 13 (size, touch, user agent).
      use: { ...devices['iPhone 13'], browserName: 'chromium', defaultBrowserType: 'chromium' },
    },
  ],
  // The real server, signing in against a stand-in Google (see e2e/serve.mjs).
  // A second server with no Google keys, for the offline sign-in tests.
  webServer: [
    {
      command: `E2E_PORT=${PORT} E2E_GOOGLE_PORT=${PORT + 1} node e2e/serve.mjs`,
      url: `http://127.0.0.1:${PORT}/healthz`,
      reuseExistingServer: false,
    },
    {
      command: `E2E_NO_GOOGLE=1 E2E_PORT=${OFFLINE_PORT} E2E_DATA=.e2e-env/e2e-data-offline node e2e/serve.mjs`,
      url: `http://127.0.0.1:${OFFLINE_PORT}/healthz`,
      reuseExistingServer: false,
    },
  ],
});
