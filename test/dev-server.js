'use strict';
// Runs the real page and the real Code.gs on your computer, with a pretend sheet in memory.
// To try it: npm run dev, then open http://localhost:8787 (passcode: test-passcode).
// Nothing here is saved or sent to Google.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createBackend } = require('./fake-gas');

const DOCS = path.join(__dirname, '..', 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

/**
 * `lookup` stands in for Open Food Facts, so nothing goes to the internet:
 * { barcode: { product fields, delay: ms } }. Every lookup asked for is recorded in `lookups`.
 */
function startServer({ port = 8787, lookup = {} } = {}) {
  const backend = createBackend();
  const lookups = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const asked = url.pathname.match(/^\/lookup\/(\w+)\.json$/);
    if (asked) {
      const code = asked[1];
      lookups.push(code);
      const { delay = 0, ...product } = lookup[code] || {};
      setTimeout(() => {
        const found = Boolean(lookup[code]);
        res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(found ? { code, status: 1, product } : { code, status: 0, status_verbose: 'product not found' }));
      }, delay);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const output = backend.context.doPost({ postData: { contents: body } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(output.text);
      });
      return;
    }
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end("window.FOOD_BANK_CONFIG = { apiUrl: '/api', lookupUrl: '/lookup/' };");
      return;
    }
    const file = path.normalize(path.join(DOCS, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, backend, lookups, url: `http://localhost:${server.address().port}` }));
  });
}

if (require.main === module) {
  startServer().then(({ url }) => console.log(`Open ${url} (passcode: test-passcode). Data is pretend and resets on restart.`));
}

module.exports = { startServer };
