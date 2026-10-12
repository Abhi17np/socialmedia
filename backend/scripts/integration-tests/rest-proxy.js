// Thin reverse proxy for local integration testing: supabase-js always
// calls `${SUPABASE_URL_SOCIAL}/rest/v1/...` — PostgREST has no
// path-prefix option of its own, so this strips /rest/v1 and forwards
// to the real PostgREST instance (see postgrest.conf.example). Point
// SUPABASE_URL_SOCIAL at this proxy's port (3001 by default), not at
// PostgREST's own port (3002 in the example config) directly.
const http = require('http');

const TARGET_PORT = process.env.POSTGREST_PORT || 3002;
const LISTEN_PORT = process.env.PROXY_PORT || 3001;

const server = http.createServer((req, res) => {
  const strippedUrl = req.url.replace(/^\/rest\/v1/, '') || '/';
  const proxyReq = http.request({ host: 'localhost', port: TARGET_PORT, path: strippedUrl, method: req.method, headers: req.headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Proxy error: ' + err.message);
  });
  req.pipe(proxyReq);
});

server.listen(LISTEN_PORT, () => console.log(`rest-proxy listening on ${LISTEN_PORT}, forwarding /rest/v1/* to localhost:${TARGET_PORT}`));
