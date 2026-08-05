const { defineConfig } = require('playwright/test');
const path = require('node:path');

module.exports = defineConfig({
  testDir: '.',
  testMatch: 'ab-kitchen-isolation.spec.js',
  timeout: 20_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    channel: 'chrome',
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node tests/static-server.cjs 4174',
    cwd: path.resolve(__dirname, '..'),
    url: 'http://127.0.0.1:4174/ab-kitchen/',
    reuseExistingServer: true,
    timeout: 30_000
  }
});
