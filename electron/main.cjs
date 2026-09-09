const { app, BrowserWindow, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_SCHEME = 'abkitchen';
const APP_HOST = 'app';
const WEB_ROOT = path.resolve(__dirname, '..', 'app');

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
}]);

function resolveAppFile(requestUrl) {
  const url = new URL(requestUrl);
  if (url.host !== APP_HOST) return null;

  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const target = path.resolve(WEB_ROOT, relativePath);
  const allowedRoot = WEB_ROOT.endsWith(path.sep) ? WEB_ROOT : `${WEB_ROOT}${path.sep}`;
  return target === WEB_ROOT || target.startsWith(allowedRoot) ? target : null;
}

async function createMainWindow() {
  const window = new BrowserWindow({
    title: 'AB Kitchen — Кухня Ашрама Бхактиведанты',
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#f7f3ee',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url);
    if (destination.protocol === `${APP_SCHEME}:` && destination.host === APP_HOST) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  await window.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  window.once('ready-to-show', () => window.show());
}

app.whenReady().then(async () => {
  protocol.handle(APP_SCHEME, request => {
    const target = resolveAppFile(request.url);
    if (!target) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });

  await createMainWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createMainWindow();
  });
});

app.on('window-all-closed', () => app.quit());
