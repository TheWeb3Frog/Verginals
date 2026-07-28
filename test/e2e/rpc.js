// Tiny RPC helper for the ISOLATED regtest node on 127.0.0.1:18443.
// It never talks to any other port, so the mainnet wallet on 20103 cannot be touched.
const http = require('http');

const PORT = 18443;
const AUTH = 'Basic ' + Buffer.from('regtest:regtestpass').toString('base64');

function rpc(method, params = []) {
  const body = JSON.stringify({ jsonrpc: '1.0', id: 'rt', method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/', timeout: 120000,
      headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body), authorization: AUTH },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(method + ': ' + (j.error.message || JSON.stringify(j.error))));
          resolve(j.result);
        } catch (e) { reject(new Error(method + ': unparseable: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(method + ': timeout')); });
    req.end(body);
  });
}

module.exports = { rpc };
