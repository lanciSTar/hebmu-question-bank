// 本地预览网页版：node _tools/serve_site.mjs  →  http://127.0.0.1:8123
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('_site_web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};
const PORT = Number(process.env.PORT || 8123);

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const alt = file + '.html';
    if (fs.existsSync(alt)) file = alt;
    else { res.writeHead(404).end('not found'); return; }
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log('预览地址: http://127.0.0.1:' + PORT);
});
