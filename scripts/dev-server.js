const http = require('http');
const fs = require('fs');
const path = require('path');

// Sirve docs/ como raíz web, igual que hará GitHub Pages en producción
// (Settings → Pages → carpeta /docs). El resto del repo (catalog/, scripts/,
// tools/) no es alcanzable por HTTP, ni aquí ni en producción.
const root = path.resolve(__dirname, '..', 'docs');
const port = process.env.PORT || 8879;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, () => console.log('Serving ' + root + ' at http://localhost:' + port));
