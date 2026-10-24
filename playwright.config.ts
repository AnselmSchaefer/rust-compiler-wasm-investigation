import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:8787' },
  webServer: { command: 'node scripts/serve.mjs tests/e2e/fixtures /www=build/www /vendor=build/vendor /release=build/release', port: 8787, reuseExistingServer: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // WebKit needs Ubuntu-only system libs on this Arch host; Safari is checked manually ([H]).
    ...(process.env.PW_WEBKIT ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],
});
