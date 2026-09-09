import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const appRoot = path.join(root, 'app');
const required = [
  'index.html', 'login.html', 'js/config.js', 'js/auth-check.js', 'js/layout.js',
  'kitchen/menu.html', 'kitchen/menu-board.html', 'kitchen/menu-templates.html',
  'kitchen/recipes.html', 'kitchen/products.html', 'stock/stock.html', 'stock/requests.html'
];

const failures = [];
for (const relative of required) {
  if (!fs.existsSync(path.join(appRoot, relative))) failures.push(`Нет обязательного файла: app/${relative}`);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

for (const htmlFile of walk(appRoot).filter(file => file.endsWith('.html'))) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const attributePattern = /<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    const reference = match[1].split(/[?#]/, 1)[0];
    if (!reference || /^(?:https?:|data:|#)/i.test(reference)) continue;
    const target = reference.startsWith('/')
      ? path.join(appRoot, reference.slice(1))
      : path.resolve(path.dirname(htmlFile), reference);
    if (!fs.existsSync(target)) {
      failures.push(`Не найдена локальная зависимость ${match[1]} из ${path.relative(appRoot, htmlFile)}`);
    }
  }
}

const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
if (!main.includes('contextIsolation: true')) failures.push('Electron contextIsolation должен быть включён');
if (!main.includes('nodeIntegration: false')) failures.push('Electron nodeIntegration должен быть выключен');
if (!main.includes('sandbox: true')) failures.push('Electron sandbox должен быть включён');
if (/loadURL\(['"]https?:\/\//.test(main)) failures.push('Приложение не должно загружать веб-версию BackOffice');

const auth = fs.readFileSync(path.join(appRoot, 'js', 'auth-check.js'), 'utf8');
if (!auth.includes("rpc('has_ab_kitchen_access')")) failures.push('Нет серверной проверки роли AB Kitchen');

const layout = fs.readFileSync(path.join(appRoot, 'js', 'layout.js'), 'utf8');
if (!layout.includes("const AB_KITCHEN_SLUG = 'ab-kitchen'")) failures.push('Не зафиксирована локация AB Kitchen');

if (failures.length) {
  console.error(failures.map(item => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log(`AB Kitchen isolation verified: ${required.length} required files, all HTML dependencies, hardened Electron window, role guard.`);
