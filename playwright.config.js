import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// В CI/контейнере может стоять Chromium другой ревизии — укажите путь через PW_CHROMIUM_PATH.
// Локально (после `npx playwright install chromium`) переменная не нужна.
const executablePath = process.env.PW_CHROMIUM_PATH
  || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'npx vite --port 5173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5173/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
