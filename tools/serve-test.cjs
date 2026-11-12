// Serves <tmp>/polyglot-ha-test/<version>/inject.js and browser-check.js to the test pages (localhost only).
const http = require('http'); const fs = require('fs'); const path = require('path');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const file = u.pathname === '/check.js' ? path.join(__dirname, 'browser-check.js') : path.join(require('os').tmpdir(), 'polyglot-ha-test', path.basename(path.dirname(u.pathname)), 'inject.js');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/javascript');
  try { res.end(fs.readFileSync(file)); } catch (e) { res.statusCode = 404; res.end(''); }
}).listen(8140, '127.0.0.1', () => console.log('serving on 8140'));
