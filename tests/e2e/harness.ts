import net from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createLogger, createServer as createViteServer, type ViteDevServer } from 'vite';
import { startApp, type TestApp } from '../integration/helpers.ts';

const root = path.resolve(import.meta.dirname, '../..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export interface Harness {
  api: TestApp;
  web: ViteDevServer;
  webUrl: string;
  browser: Browser;
  close: () => Promise<void>;
}

/**
 * A real stack: PostgreSQL (the throwaway container), the API + Socket.IO on a random
 * port, the Vite dev server proxying /api and /socket.io to it (so the browser sees ONE
 * origin, as it will behind NGINX), and a real browser (Microsoft Edge, headless).
 */
export async function startHarness(): Promise<Harness> {
  const api = await startApp();
  const webPort = await freePort();
  process.env['API_URL'] = api.base;
  process.env['WEB_PORT'] = String(webPort);
  // Closing a browser context aborts its WebSocket mid-write; Vite's proxy logs that as an
  // error. It is expected noise in these tests, so only that message is dropped.
  const viteLogger = createLogger('warn');
  const originalError = viteLogger.error.bind(viteLogger);
  viteLogger.error = (message, options) => {
    if (/ws proxy|ECONNABORTED|ECONNRESET/.test(message)) return;
    originalError(message, options);
  };
  const web = await createViteServer({
    customLogger: viteLogger,
    root: path.join(root, 'apps/web'),
    configFile: path.join(root, 'apps/web/vite.config.ts'),
    logLevel: 'warn',
  });
  await web.listen();
  const webUrl = `http://127.0.0.1:${String(webPort)}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  return {
    api,
    web,
    webUrl,
    browser,
    close: async () => {
      await browser.close();
      await web.close();
      await api.close();
    },
  };
}

export interface Watched {
  context: BrowserContext;
  page: Page;
  /** console.error / pageerror text, collected for the "no console errors" assertion. */
  problems: string[];
}

/** Opens a page, optionally already signed in (session placed in sessionStorage). */
export async function openPage(
  h: Harness,
  options: {
    session?: { token: string; userId: string; displayName: string };
    colorScheme?: 'light' | 'dark';
    viewport?: { width: number; height: number };
    hash?: string;
  } = {},
): Promise<Watched> {
  const context = await h.browser.newContext({
    colorScheme: options.colorScheme ?? 'light',
    viewport: options.viewport ?? { width: 1100, height: 900 },
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  if (options.session) {
    await context.addInitScript((s) => {
      sessionStorage.setItem('bidflow.session', JSON.stringify(s));
    }, options.session);
  }
  await page.goto(`${h.webUrl}/${options.hash ?? ''}`);
  return { context, page, problems };
}
