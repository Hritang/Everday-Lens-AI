const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/api/serverAccess.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const fixtureKey = 'a'.repeat(43);

function loadAccess() {
  const requests = [];
  let saved = null;
  let response = 204;
  const storage = {
    async loadServerPairing() { return saved; },
    async saveServerPairing(url, secret) { saved = { url, secret }; },
    async clearServerPairing() { saved = null; },
  };
  const stubs = {
    expo: { requireOptionalNativeModule: () => storage },
    'expo/fetch': { async fetch(url, options) {
      requests.push({ url, options });
      return { status: response };
    } },
  };
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, require: name => stubs[name], process: { env: {} }, URL, AbortController, setTimeout, clearTimeout,
  });
  return { access: exports, requests, setResponse: status => { response = status; } };
}

test('pairing accepts an HTTPS origin and uses a header for the key', async () => {
  const { access, requests } = loadAccess();
  for (const address of ['http://lens.example', 'https://lens.example/other', 'https://user@lens.example']) {
    await assert.rejects(access.pairServer(address, fixtureKey), /server address/);
  }
  assert.equal(requests.length, 0);
  await access.pairServer('https://lens.example/', fixtureKey);
  assert.equal(requests[0].url, 'https://lens.example/pair');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + fixtureKey);
  assert.equal(requests[0].options.redirect, 'error');
  await access.useUsbServer();
  assert.equal(access.authorization(access.getServer()).Authorization, undefined);
});

test('a revoked pairing blocks live access, while a stale rejection leaves a newer key usable', async () => {
  const { access, setResponse } = loadAccess();
  await access.pairServer('https://lens.example', fixtureKey);
  const older = access.getServer();
  await access.pairServer('https://lens.example', 'b'.repeat(43));
  access.rejectPairing(older);
  const current = access.getServer();
  assert.equal(current.secret, 'b'.repeat(43));
  setResponse(401);
  assert.equal(await access.checkLiveAccess(current, new AbortController().signal), false);
  assert.equal(access.getServer().secret, null);
});
