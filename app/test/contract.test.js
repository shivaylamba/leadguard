// The API contract: server routes, api/openapi.yaml and the browser app must agree.
// Backs the Gitar rule .gitar/rules/api-contract.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const norm = (p) => p.replace(/:[A-Za-z_]+/g, '{}').replace(/\{[^}]+\}/g, '{}');

const spec = new Set([...read('api/openapi.yaml').matchAll(/^ {2}(\/api\/[^:]+):\s*$/gm)].map((x) => norm(x[1])));
const server = read('app/src/server.js');
const routes = new Set([...server.matchAll(/app\.(?:get|post|put|delete)\('(\/api\/[^']+)'/g)].map((x) => norm(x[1])));
for (const x of server.matchAll(/\['(\/api\/[^\]]+)\]\) app\.post/g)) for (const p of x[1].split("', '")) routes.add(norm(p.replace(/'/g, '')));
const ui = read('app/public/app.js');
// api('/api/a') and api('/api/a/' + encodeURIComponent(x) + '/b'): a concatenated segment is a parameter.
const called = new Set([...ui.matchAll(/(?:api|post)\('(\/api\/[^'?]*)'(?:\s*\+[^']*?'(\/[^'?]*)')?/g)]
  .map((x) => norm(x[2] ? `${x[1].replace(/\/$/, '')}/{}${x[2]}` : x[1])));

test('every server route is in the OpenAPI spec', () => {
  for (const r of routes) assert.ok(spec.has(r), `route ${r} missing from api/openapi.yaml`);
});

test('every spec path is served', () => {
  for (const p of spec) assert.ok(routes.has(p), `api/openapi.yaml documents ${p} but the server has no route for it`);
});

test('every API path the browser calls exists in the spec', () => {
  assert.ok(called.size >= 8, `expected the UI to call several endpoints, found ${[...called].join(', ')}`);
  for (const c of called) assert.ok(spec.has(c), `app/public/app.js calls ${c}, which api/openapi.yaml does not define`);
});
