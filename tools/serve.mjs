import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// 极简静态服务器：给 Tampermonkey 一个可抓取的 .user.js URL
const ROOT = process.argv[2] || 'D:\\agent\\deepseek\\suno\\migrate';
const PORT = Number(process.argv[3] || 3457);

const MIME = { '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found: ' + rel); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      'access-control-allow-origin': '*',
    });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`static server on http://127.0.0.1:${PORT} root=${ROOT}`));
