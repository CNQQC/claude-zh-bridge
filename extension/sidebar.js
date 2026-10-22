(() => {
  'use strict';
  const engine = self.ClaudeZhTranslator, records = new Map();
  const SIDEBAR = 'aside[aria-label="Sidebar"],[data-testid="sidebar"],nav[aria-label="Sidebar"],.dframe-sidebar';
  const SKIP = 'svg,script,style,button,[role="button"],[aria-hidden="true"],[hidden],.sr-only,.df-leading-slot,[data-czt-owned]';
  let active = false, epoch = 0, busy = false;

  function restore(record) {
    for (const entry of record.entries) {
      if (record.done && entry.node.nodeValue === entry.translated) entry.node.nodeValue = entry.source;
    }
    for (const entry of record.attributes || []) {
      if (entry.el.getAttribute(entry.name) === entry.translated) {
        if (entry.source === null) entry.el.removeAttribute(entry.name);
        else entry.el.setAttribute(entry.name, entry.source);
      }
    }
  }
  function clear() {
    active = false; epoch++;
    for (const record of records.values()) restore(record);
    records.clear();
  }
  function textNodes(label) {
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const blocked = node.parentElement.closest(SKIP);
      if (!blocked || blocked.matches('[data-row-main-button]')) nodes.push(node);
    }
    return nodes;
  }
  function targetHref(link) {
    const href = link.getAttribute('href');
    if (href) { try { return new URL(href, location.href).href; } catch { return ''; } }
    const code = self.CztChatScope.isCodeURL(location.href);
    const codeRow = code && link.matches('[data-row-main-button]') && link.closest('[data-row-key]');
    if (codeRow) return 'czt-code-session:' + codeRow.getAttribute('data-row-key');
    const row = link.closest('[data-row-key^="chat:"]');
    const id = row?.getAttribute('data-row-key').slice(5);
    return id && /^[A-Za-z0-9_-]+$/.test(id) ? 'https://claude.ai/chat/' + id : '';
  }
  function targets() {
    const links = new Set([...document.querySelectorAll(SIDEBAR)].flatMap(sidebar => [...sidebar.querySelectorAll('a[href],button[data-row-main-button],[role="button"][data-row-main-button]')]));
    return [...links].flatMap(link => {
      if (!link.getClientRects().length || link.closest('[hidden],[aria-hidden="true"],[inert]')) return [];
      let url;
      const href = targetHref(link), codeSession = self.CztChatScope.isCodeURL(location.href) && href.startsWith('czt-code-session:');
      try { url = new URL(href); } catch { return []; }
      if (!codeSession && (url.origin !== 'https://claude.ai' || (!/^\/chat\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !self.CztChatScope.isCodeURL(href)))) return [];
      const label = link.querySelector('[data-row-label],.truncate,.text-ellipsis') || link;
      const nodes = textNodes(label), old = records.get(link);
      // Reconstruct the original from our own replacements. React may update or
      // replace these text nodes at any time; those changes start a new record.
      const entries = nodes.map(node => {
        const previous = old?.done && old.entries.find(entry => entry.node === node && entry.translated === node.nodeValue);
        return { node, source: previous ? previous.source : node.nodeValue };
      });
      const source = entries.map(entry => entry.source).join('').trim();
      return source && source.length <= 1000 ? [{ link, label, entries, source, href: targetHref(link) }] : [];
    });
  }
  function valid(record, started, atRoute) {
    return active && epoch === started && location.href === atRoute && self.CztChatScope.isChatURL(location.href) &&
      records.get(record.link) === record && record.link.isConnected && targetHref(record.link) === record.href &&
      record.entries.every(entry => record.label.contains(entry.node) && entry.node.nodeValue === entry.source);
  }
  function display(record, translated) {
    record.attributes = [];
    for (const el of new Set([record.link, record.label])) {
      for (const name of ['title', 'aria-label']) {
        const source = el.getAttribute(name);
        if (source?.trim() !== record.source) continue;
        record.attributes.push({ el, name, source, translated });
        el.setAttribute(name, translated);
      }
    }
    record.entries.forEach((entry, i) => {
      entry.translated = i ? '' : translated;
      entry.node.nodeValue = entry.translated;
    });
    record.done = true;
  }
  async function restoreCached(record) {
    record.checking = true;
    const started = epoch, atRoute = location.href;
    try {
      const saved = await engine.getView(record.source, 'title');
      if (valid(record, started, atRoute) && typeof saved?.text === 'string' && saved.text.trim()) display(record, saved.text);
    } catch {
      if (valid(record, started, atRoute)) record.error = true;
    } finally { record.checking = false; }
  }
  async function translate(batch) {
    busy = true;
    const started = epoch, atRoute = location.href;
    batch.forEach(record => { record.pending = true; });
    try {
      // Full titles share the existing durable segment cache and in-flight
      // deduplication. No separate API, cache reset, or automatic paid retry.
      const translations = await engine.translateMany(batch.map(record => record.source), 'en:zh');
      await Promise.all(batch.map(async (record, index) => {
        if (!valid(record, started, atRoute)) return;
        const translated = translations[index];
        if (typeof translated !== 'string' || !translated.trim()) return;
        await engine.saveView(record.source, 'title', { html: '', text: translated });
        if (valid(record, started, atRoute)) display(record, translated);
      }));
    } catch (error) {
      // Backend failures are already persistent blockers; a refresh cannot
      // silently re-submit a paid request whose result is unknown.
      for (const record of batch) {
        if (!valid(record, started, atRoute)) continue;
        if (error.code === 'NO_KEY') record.cacheMiss = true;
        else record.error = true;
      }
    } finally {
      batch.forEach(record => { record.pending = false; });
      busy = false;
    }
  }
  function scan(enabled, allowRequest = true) {
    if (!enabled || !self.CztChatScope.isChatURL(location.href)) { clear(); return; }
    active = true;
    const found = targets(), current = new Set(found.map(item => item.link));
    for (const [link, record] of records) if (!current.has(link)) { restore(record); records.delete(link); }
    for (const target of found) {
      const old = records.get(target.link);
      if (old && old.label === target.label && old.href === target.href && old.source === target.source &&
          old.entries.length === target.entries.length && old.entries.every((entry, index) => entry.node === target.entries[index].node)) continue;
      if (old) restore(old);
      // Restore can change only our own text; never replace a renamed title.
      target.entries = target.entries.map(entry => ({ node: entry.node, source: entry.node.nodeValue }));
      target.source = target.entries.map(entry => entry.source).join('').trim();
      records.set(target.link, { ...target, changed: Date.now(), done: !engine.needsProseTranslation(target.source, 'en:zh') });
    }
    for (const record of records.values()) if (!record.done && !record.cacheChecked && !record.error) {
      record.cacheChecked = true; void restoreCached(record);
    }
    if (!allowRequest || busy) return;
    const batch = [...records.values()].filter(record => !record.done && !record.pending && !record.checking && !record.error &&
      (!record.cacheMiss || engine.ready) && Date.now() - record.changed >= 600);
    if (batch.length) void translate(batch);
  }
  function retry() {
    for (const record of records.values()) { record.error = false; record.cacheMiss = false; }
  }
  self.CztSidebarTranslator = { scan, clear, retry };
})();
