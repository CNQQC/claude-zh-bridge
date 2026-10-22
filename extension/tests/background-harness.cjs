const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function createBackground({ fetch: fetcher, initialKey, builtInKey, timers = {}, localStore = {}, failWrites = () => false } = {}) {
  const stored = initialKey ? { cztDeepSeekKey: initialKey } : {};
  let listener, accessLevel, opened = false;
  const chrome = {
    storage: { session: {
      setAccessLevel: async value => { accessLevel = value.accessLevel; },
      get: async names => Object.fromEntries((typeof names === 'string' ? [names] : names || Object.keys(stored)).map(name => [name, stored[name]])),
      set: async value => Object.assign(stored, value),
      remove: async name => { delete stored[name]; }
    }, local: {
      get: async names => {
        const keys = names == null ? Object.keys(localStore) : typeof names === 'string' ? [names] : names;
        return JSON.parse(JSON.stringify(Object.fromEntries(keys.filter(name => name in localStore).map(name => [name, localStore[name]]))));
      },
      set: async values => { if (failWrites(values)) throw new Error('Storage full'); Object.assign(localStore, JSON.parse(JSON.stringify(values))); },
      remove: async names => { for (const name of typeof names === 'string' ? [names] : names) delete localStore[name]; }
    } },
    runtime: { getURL: file => `chrome-extension://test-extension/${file}`,
      openOptionsPage: async () => { opened = true; }, onMessage: { addListener: fn => { listener = fn; } } }
  };
  const context = vm.createContext({ chrome, fetch: fetcher || fetch, URL, AbortController, TextEncoder, crypto: require('node:crypto').webcrypto, setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout, Date });
  context.self = context;
  context.importScripts = (...files) => files.forEach(file => {
    if (file === 'private-config.js') { context.CztPrivateConfig = { apiKey: builtInKey || '' }; return; }
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  return {
    send: (message, url = 'https://claude.ai/new') => new Promise(resolve => {
      if (listener(message, { url }, resolve) === false) resolve(undefined);
    }),
    get stored() { return stored; }, get localStore() { return localStore; }, get accessLevel() { return accessLevel; }, get opened() { return opened; }
  };
}
module.exports = { createBackground };
