const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2] || 4174);
const root = path.resolve(__dirname, '..');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  let filePath = path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  });
  fs.createReadStream(filePath).pipe(response);
}).listen(port, '127.0.0.1');
