'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const copy = value => JSON.parse(JSON.stringify(value));
function createStorage(file, changed = () => {}) {
  let data, session = {}, queue = Promise.resolve();
  async function load() {
    if (data) return;
    try { data = JSON.parse(await fs.readFile(file, 'utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid cache'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Desktop translation cache is unreadable; refusing to reset it.'); data = {}; }
  }
  function select(source, keys) {
    const names = keys == null ? Object.keys(source) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return copy(Object.fromEntries(names.filter(key => key in source).map(key => [key, source[key]])));
  }
  function update(mutator) {
    const operation = queue.then(async () => {
      await load(); const next = copy(data); mutator(next);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.tmp'; let handle;
      try {
        handle = await fs.open(temporary, 'w', 0o600); await handle.writeFile(JSON.stringify(next)); await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temporary, file); const previous = data; data = next;
        const changes = {};
        for (const key of ['cztSettings', 'cztRefreshAt']) if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = {newValue:next[key]};
        if (Object.keys(changes).length) changed(changes);
      } finally { if (handle) await handle.close(); }
    });
    queue = operation.catch(() => {}); return operation;
  }
  return {
    local: {
      get: async keys => { await queue; await load(); return select(data, keys); },
      set: values => update(next => Object.assign(next, copy(values))),
      remove: keys => update(next => { for (const key of typeof keys === 'string' ? [keys] : keys) delete next[key]; })
    },
    session: {
      setAccessLevel: async () => {}, get: async keys => select(session, keys),
      set: async values => { Object.assign(session, copy(values)); },
      remove: async key => { delete session[key]; }
    }
  };
}
module.exports = { createStorage };
