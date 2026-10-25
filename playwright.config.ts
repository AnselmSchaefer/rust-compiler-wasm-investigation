import { defineConfig, devices } from '@playwright/test';

// PW_PORT: another port for the test server, e.g. while `pnpm demo` holds 8787 (the test server
// is reused if one is already running there, and the demo's layout is different).
const port = Number(process.env.PW_PORT ?? 8787);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  use: { baseURL: `http://localhost:${port}` },
  webServer: { command: `PORT=${port} node scripts/serve.mjs tests/e2e/fixtures /www=build/www /vendor=build/vendor /release=build/release /index=build/wp-15/index /l2=build/l2`, port, reuseExistingServer: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // WebKit needs Ubuntu-only system libs on this Arch host; Safari is checked manually ([H]).
    ...(process.env.PW_WEBKIT ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],
});
