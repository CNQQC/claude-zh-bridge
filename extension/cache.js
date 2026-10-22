(() => {
  'use strict';
  const CONTRACT = 'deepseek-flash|thinking-disabled|translation-json-v1';
  const PREFIX = 'czt-cache-v1:';
  const normalize = text => text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  class CacheError extends Error {
    constructor() { super('本机翻译缓存无法写入，已停止处理以避免刷新后重复计费。请检查磁盘空间和插件存储权限。'); this.name = 'CacheError'; this.code = 'CACHE_STORAGE'; }
  }
  async function id(kind, text, direction = '', namespace) {
    const source = kind === 'view' ? text.replace(/\r\n?/g, '\n') : normalize(text);
    const contract=kind==='original'?CONTRACT:(namespace||self.CztRuntimeConfig?.()?.cacheNamespace||CONTRACT);
    const bytes = new TextEncoder().encode(JSON.stringify([contract, kind, direction, source]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return PREFIX + kind + ':' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function read(keys) { return chrome.storage.local.get(keys); }
  async function write(values) {
    try { await chrome.storage.local.set(values); } catch { throw new CacheError(); }
  }
  async function getView(source, role) {
    const name = await id('view', source, role);
    return (await read(name))[name]?.view || null;
  }
  async function putView(source, role, view) {
    if (!['user', 'assistant', 'title'].includes(role) || typeof source !== 'string' || source.length > 500000 || typeof view?.html !== 'string' || view.html.length > 4000000 || (role === 'title' && (typeof view.text !== 'string' || !view.text.trim() || view.text.length > 6000))) throw new Error('Invalid cache view');
    const name = await id('view', source, role);
    await write({ [name]: { view, savedAt: Date.now() } });
  }
  // Match harmless paragraph spacing differences, while preserving code exactly.
  function originalKey(text) {
    const parts = normalize(text).split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g);
    return JSON.stringify(parts.map((part, index) => index % 2 ? part : part.replace(/\s+/g, ' ')));
  }
  let originalWrites = Promise.resolve();
  async function getOriginal(english) {
    const name = await id('original', originalKey(english));
    return (await read(name))[name]?.original || null;
  }
  function putOriginal(english, original) {
    if (typeof english !== 'string' || typeof original !== 'string' || english.length > 160000 || original.length > 160000) throw new Error('Invalid original text');
    const operation = originalWrites.then(async () => {
      const name = await id('original', originalKey(english));
      const old = (await read(name))[name];
      const versions = old?.versions || (old?.original ? [old.original] : []);
      if (!versions.includes(original)) versions.push(original);
      await write({ [name]: { original: old?.original || original, versions, english, savedAt: Date.now() } });
    });
    originalWrites = operation.catch(() => {});
    return operation;
  }
  self.CztCache = { PREFIX, id, read, write, getView, putView, getOriginal, putOriginal };
})();
