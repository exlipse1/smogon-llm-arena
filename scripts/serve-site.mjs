import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.resolve(rootDir, process.argv[2] ?? 'site');
const port = Number(process.argv[3] ?? process.env.PORT ?? 4173);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(siteDir, cleanPath);
    if (!filePath.startsWith(siteDir)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeTypes.get(path.extname(filePath)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(data);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(500);
    response.end(String(error?.message ?? error));
  }
});

server.listen(port, () => {
  console.log(`Smogon LLM Arena dashboard: http://localhost:${port}`);
});
