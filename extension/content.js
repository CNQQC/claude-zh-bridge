(() => {
  'use strict';
  if (self.__claudeZhInstalled) return;
  self.__claudeZhInstalled = true;
  const engine = self.ClaudeZhTranslator;
  const EDITOR = '.ProseMirror[contenteditable]:not([contenteditable="false"]),[contenteditable][data-testid="chat-input"]:not([contenteditable="false"]),[contenteditable][role="textbox"]:not([contenteditable="false"]),fieldset [contenteditable]:not([contenteditable="false"]),form [contenteditable]:not([contenteditable="false"]),textarea[data-testid="chat-input"],textarea[placeholder]';
  const ROOT = '[data-testid="assistant-message"],[data-message-author-role="assistant"],[data-message-role="assistant"],.font-claude-response';
  const USER_ROOT = '[data-testid="user-message"],[data-message-author-role="user"],[data-message-role="user"],.font-user-message';
  const codePage = () => self.CztChatScope.isCodeURL(location.href);
  const CODE_EXCLUDED = 'pre,code,.sr-only,[hidden],[aria-hidden="true"],[role="log"],[role="dialog"],[role="menu"],[data-testid="tool-result"],[data-testid="tool-call"],[data-czt-owned]';
  const SEND = 'button[data-testid="send-button"],button[data-testid="send-message-button"],button[aria-label*="send" i],[role="button"][aria-label*="send" i],button[aria-label*="发送"],button[title*="send" i],button[title*="发送"]';
  const STOP = 'button[aria-label="Stop response"],button[aria-label="Stop generating"],button[aria-label="停止回复"],button[data-testid="stop-button"]';
  let settings = { input: true, output: true, titles:true, chat:true, code:true };
  let sending = false, bypass = false, initialized = false, scanTimer, ui, stateLabel, observer, chatActive = false, activation = 0, toastTimer;
  let route = location.href, revision = 0, sendEpoch = 0, inComposition = false, cancelPending;
  const records = new Map();
  const read = el => (el.tagName === 'TEXTAREA' ? el.value : el.innerText ?? el.textContent).replace(/\r\n/g, '\n');
  const visible = el => el.getClientRects().length && !el.closest('[data-czt-owned],[hidden],[aria-hidden="true"]');
  function editors() {
    if (!self.CztChatScope.isChatURL(location.href)) return [];
    const exact = [...document.querySelectorAll(EDITOR)].filter(visible);
    if (exact.length) return exact;
    // Claude can change its editor classes; a single visible rich-text editor
    // is a safe fallback. Never guess among multiple unrelated editable fields.
    const generic = [...document.querySelectorAll('[contenteditable]:not([contenteditable="false"])')].filter(visible);
    return generic.length === 1 ? generic : [];
  }
  function isChatPage() {
    if (codePage() ? !settings.code : !settings.chat) return false;
    if (!self.CztChatScope.isChatURL(location.href)) return false;
    const strong = '.ProseMirror[contenteditable]:not([contenteditable="false"]),[data-testid="chat-input"][contenteditable]:not([contenteditable="false"]),textarea[data-testid="chat-input"],[contenteditable][role="textbox"]:not([contenteditable="false"])';
    if ([...document.querySelectorAll(strong)].some(visible)) return true;
    if ([...document.querySelectorAll(ROOT + ',' + USER_ROOT)].some(el => !el.closest('[data-czt-owned]') && (visible(el) || el.hasAttribute('data-czt-original-hidden')))) return true;
    // The home URL may also show a signed-out landing page. It must contain a
    // real chat surface; generic newsletter/search textareas do not activate it.
    return location.pathname !== '/' && editors().length > 0;
  }
  function deactivate() {
    self.CztSidebarTranslator?.clear();
    if (!chatActive && !ui) return;
    chatActive = false; activation++; sendEpoch++; inComposition = false;
    cancelPending?.();
    clearTimeout(scanTimer); observer?.disconnect();
    for (const record of records.values()) clearView(record);
    records.clear(); ui?.remove(); ui = null; stateLabel = null;
  }
  function ensureChatActive() {
    if (!isChatPage()) { deactivate(); return false; }
    if (!chatActive) scan();
    return chatActive;
  }
  const editor = () => {
    const candidates = editors();
    return candidates.find(el => el === document.activeElement || el.contains(document.activeElement)) || candidates[0];
  };
  const status = (text, error = false, force = false) => {
    if (!stateLabel) return;
    if (!force && !error && stateLabel.getAttribute('data-error') === 'true') return;
    if (stateLabel.textContent !== text) stateLabel.textContent = text;
    stateLabel.setAttribute('data-error', String(error));
    // Routine progress and success stay silent. Only actionable failures appear,
    // temporarily, without occupying any space in the conversation.
    clearTimeout(toastTimer);
    ui.hidden = !error;
    if (error) toastTimer = setTimeout(() => { if (ui) ui.hidden = true; }, 12000);
  };
  function sendButton(el) {
    // A scoped match is safer when Claude has more than one composer on screen.
    for (let parent = el?.parentElement, depth = 0; parent && parent !== document.body && parent !== document.documentElement && depth < 12; parent = parent.parentElement, depth++) {
      const button = [...parent.querySelectorAll(SEND)].find(candidate => visible(candidate) && !/stop|cancel|停止|取消/i.test(candidate.getAttribute('aria-label') || ''));
      if (button) return button;
      // A submit button needs no accessible label; scope this fallback to the
      // actual composer's form/fieldset so other page forms are never selected.
      if (parent.matches('form,fieldset')) {
        const submit = [...parent.querySelectorAll('button[type="submit"],input[type="submit"],form button:not([type])')].find(visible);
        if (submit) return submit;
      }
    }
    return null;
  }
  function halt(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  function writeEditor(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      // Use the editing pipeline so ProseMirror/React receive the transaction.
      // Never replace innerHTML: it would bypass Claude's editor state.
      if (!document.execCommand('insertText', false, text)) throw new Error('输入框不支持安全替换，已取消发送。');
    }
    if (read(el).trim() !== text.trim()) throw new Error('输入框写入校验失败，已取消发送。');
  }
  async function translateAndSend(el, submit = true) {
    if (!ensureChatActive()) return;
    if (sending) return;
    sending = true;
    el.setAttribute('data-czt-translating', '');
    const original = read(el), oldRevision = revision, oldRoute = location.href, epoch = ++sendEpoch;
    const cancelled = new Promise((_, reject) => { cancelPending = () => reject(new Error('已关闭输入翻译，取消本次发送。')); });
    const cancellable = job => Promise.race([job, cancelled]);
    let written = false, translated;
    const valid = () => chatActive && isChatPage() && epoch === sendEpoch && location.href === oldRoute && el.isConnected && (!submit || settings.input);
    try {
      status('正在将输入译成英文…', false, true);
      translated = await cancellable(engine.translate(original, 'zh:en'));
      if (!valid() || revision !== oldRevision || read(el) !== original) throw new Error('输入或页面已变化，已取消发送。');
      if (engine.needsProseTranslation(translated, 'zh:en')) throw new Error('译文仍含中文，已取消发送，请检查原文。');
      if (engine.needsProseTranslation(original, 'zh:en')) await cancellable(engine.rememberOriginal(translated, original));
      if (!valid() || revision !== oldRevision || read(el) !== original) throw new Error('输入或页面已变化，已取消发送。');
      if (submit && !sendButton(el)) throw new Error('未找到发送按钮，已保留中文。');
      writeEditor(el, translated);
      written = true;
      if (!submit) { status('英文已填回输入框，尚未发送。'); return; }
      const afterWriteRevision = revision;
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!valid() || revision !== afterWriteRevision || read(el).trim() !== translated.trim()) throw new Error('输入或页面已变化，已取消发送。');
        const button = sendButton(el);
        if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
          bypass = true;
          try { button.click(); } finally { bypass = false; }
          status('英文已提交 · 等待 Claude 回复');
          return;
        }
      }
      throw new Error('发送按钮尚未就绪，已恢复中文，请重试。');
    } catch (error) {
      if (written && el.isConnected && location.href === oldRoute && read(el).trim() === translated?.trim()) {
        try { writeEditor(el, original); } catch { /* Keep the existing draft if the editor changed. */ }
      }
      status(error.message || '翻译失败，已取消发送。', true);
    } finally { sending = false; cancelPending = null; el.removeAttribute('data-czt-translating'); }
  }
  function handleSend(event, el) {
    if (!ensureChatActive()) return;
    if (bypass || !el) return;
    if (sending) { halt(event); return; }
    if (!settings.input || !engine.needsTranslation(read(el), 'zh:en')) return;
    halt(event);
    void translateAndSend(el);
  }
  window.addEventListener('compositionstart', () => { inComposition = true; }, true);
  window.addEventListener('compositionend', () => { inComposition = false; }, true);
  function eventEditor(event) {
    const candidates = editors();
    return candidates.find(el => event.composedPath().includes(el) || el.contains(event.target));
  }
  window.addEventListener('input', event => { if (eventEditor(event)) revision++; }, true);
  window.addEventListener('keydown', event => {
    if (!ensureChatActive()) return;
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || inComposition || event.keyCode === 229) return;
    const el = eventEditor(event);
    if (el) handleSend(event, el);
  }, true);
  window.addEventListener('click', event => {
    if (!ensureChatActive()) return;
    const button = event.composedPath().find(node => node?.matches?.('button,[role="button"],input[type="submit"]'));
    if (!button) return;
    const el = editors().find(candidate => sendButton(candidate) === button);
    if (el) handleSend(event, el);
  }, true);
  window.addEventListener('submit', event => {
    if (!ensureChatActive()) return;
    const el = editors().find(candidate => event.target.contains(candidate));
    if (el) handleSend(event, el);
  }, true);

  function clearView(record) {
    record.root.removeAttribute('data-czt-original-hidden');
    record.root.removeAttribute('data-czt-toggle-source');
    record.view?.remove(); record.controls?.remove();
    record.view = null; record.controls = null;
  }
  function translatableNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest('pre,code,kbd,samp,svg,math,mjx-container,[data-czt-owned]')) continue;
      if (engine.needsTranslation(node.nodeValue, 'en:zh')) nodes.push(node);
    }
    return nodes;
  }
  function safeClone(root) {
    const clone = root.cloneNode(true);
    clone.removeAttribute('data-czt-original-hidden');
    clone.querySelectorAll('script,style,link,meta,base,template,iframe,object,embed,form,input,textarea,button,video,audio,source,img').forEach(el => el.remove());
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || ['id','style','contenteditable','autofocus','src','srcset','data-testid','data-is-streaming'].includes(attr.name)) el.removeAttribute(attr.name);
      }
      if (el.hasAttribute('href')) {
        const href = el.getAttribute('href');
        if (!/^(https?:\/\/|mailto:|#|\/)/i.test(href) || href.startsWith('//')) el.removeAttribute('href');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    clone.classList.add('czt-translation');
    clone.setAttribute('data-czt-owned', 'translation');
    // The marker would make the text walker skip every descendant; translate first.
    return clone;
  }
  function replyBatch(pending, prepared) {
    const waiting = new Set(pending), jobs = [];
    function ready(record) {
      if (!waiting.delete(record) || waiting.size) return;
      prepared();
      const current = jobs.filter(job => job.valid());
      for (const job of jobs) if (!current.includes(job)) job.resolve([]);
      if (!current.length) return;
      engine.translateMany(current.flatMap(job => job.texts), 'en:zh').then(translations => {
        let offset = 0;
        for (const job of current) { job.resolve(translations.slice(offset, offset + job.texts.length)); offset += job.texts.length; }
      }, error => current.forEach(job => job.reject(error)));
    }
    return { ready, translate: (record, texts, valid) => new Promise((resolve, reject) => {
      jobs.push({ texts, valid, resolve, reject }); ready(record);
    }) };
  }
  async function translateReply(record, cacheOnly = false, batch = null) {
    record.busy = true;
    record.checkingCache = cacheOnly;
    record.preparing = !!batch;
    const fingerprint = record.text, atRoute = location.href;
    const valid = () => chatActive && isChatPage() && settings.output && atRoute === location.href && record.root.isConnected && record.root.textContent === fingerprint && records.get(record.root) === record;
    try {
      if (!valid()) return;
      let view, saved = await engine.getView(fingerprint, record.role), fromCache = !!saved;
      if (!valid()) return;
      // Repair only old views affected by currency being mistaken for math.
      // Keep every paid segment; the backend reuses them when rebuilding.
      if (saved && !saved.currencyFix && /\$\d/.test(fingerprint)) {
        const template = document.createElement('template'); template.innerHTML = saved.html;
        if (/\$\d[\d,.]*\s+[A-Za-z]{2,}/.test(template.content.textContent)) { saved = null; fromCache = false; }
      }
      if (saved) {
        const template = document.createElement('template'); template.innerHTML = saved.html;
        const element = template.content.firstElementChild;
        if (!element || !['DIV','P','SECTION','ARTICLE','SPAN','PRE','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','LI','TD','TH'].includes(element.tagName)) throw new Error('已保存的显示格式无效，未重复调用 API。');
        view = safeClone(element);
      } else {
        view = safeClone(record.root); view.removeAttribute('data-czt-owned');
        const original = record.role === 'user' ? await engine.getOriginal(read(record.root)) : null;
        if (!valid()) return;
        if (original) {
          view.replaceChildren(document.createTextNode(original));
          view.classList.add('czt-user-original');
        } else {
          const nodes = translatableNodes(view);
          if (!nodes.length) { record.done = fingerprint; return; }
          if (cacheOnly) return;
          status(record.role === 'user' ? '正在翻译已发送消息…' : '正在翻译 Claude 回复…');
          if (!valid()) return;
          const texts = nodes.map(node => node.nodeValue);
          record.preparing = false;
          const translations = await (batch ? batch.translate(record, texts, valid) : engine.translateMany(texts, 'en:zh'));
          if (!valid()) return;
          nodes.forEach((node, index) => { node.nodeValue = translations[index]; });
        }
        // Persist before displaying so a refresh cannot lose a paid result.
        if (!valid()) return;
        await engine.saveView(fingerprint, record.role, { html: view.outerHTML, currencyFix: 1 });
      }
      if (!valid() || (record.role === 'assistant' && isStreaming(record.root))) return;
      clearView(record);
      view.setAttribute('data-czt-owned', 'translation');
      const controls = document.createElement('div');
      controls.className = 'czt-controls'; controls.dataset.cztOwned = 'controls';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = 'EN';
      toggle.title = '查看英文原文'; toggle.setAttribute('aria-label', '查看英文原文');
      toggle.addEventListener('click', () => {
        const showOriginal = !view.hidden;
        view.hidden = showOriginal;
        record.root.toggleAttribute('data-czt-original-hidden', !showOriginal);
        toggle.textContent = showOriginal ? '中' : 'EN';
        toggle.title = showOriginal ? '查看中文译文' : '查看英文原文';
        toggle.setAttribute('aria-label', toggle.title);
      });
      controls.append(toggle);
      record.root.after(view, controls);
      record.root.setAttribute('data-czt-original-hidden', '');
      record.root.setAttribute('data-czt-toggle-source', '');
      Object.assign(record, { view, controls, done: fingerprint, error: null });
      status(fromCache ? '已从本机恢复译文 · 未调用 API' : '中文显示已保存到本机');
    } catch (error) {
      if (!valid()) return;
      if (error.code === 'NO_KEY') { record.cacheMiss = fingerprint; return; }
      clearView(record);
      record.error = fingerprint;
      status(`翻译未完成：${error.message}`, true);
    } finally { record.busy = false; record.checkingCache = false; record.preparing = false; batch?.ready(record); }
  }
  function isStreaming(root) {
    let messages = [...document.querySelectorAll(ROOT)].filter(el => !el.closest('[data-czt-owned]'));
    if (!messages.length && codePage()) messages = [...document.querySelectorAll('.standard-markdown,.progressive-markdown')].filter(el => !el.closest(CODE_EXCLUDED + ',' + USER_ROOT));
    const last = messages.at(-1);
    const inLatest = last && (last.contains(root) || root.contains(last));
    const stop = STOP + (codePage() ? ',button[aria-label="Stop"],button[aria-label="Interrupt"],button[aria-label="Stop task"]' : '');
    return (inLatest && [...document.querySelectorAll(stop)].some(visible)) || !!root.closest('[data-is-streaming="true"],[aria-busy="true"]') || !!root.querySelector('[data-is-streaming="true"],[aria-busy="true"]');
  }
  function codeProseRoots(base) {
    // Replace prose alone. Native code-copy, tool, approval and diff controls
    // stay in their original DOM and never enter the translation clone.
    const candidates = [...base.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote')]
      .filter(el => !el.closest(CODE_EXCLUDED) && !el.querySelector('pre,button,input,textarea,[role="button"],[role="log"],[data-testid="tool-result"],[data-testid="tool-call"]'));
    if (candidates.length) return candidates.filter(el => !candidates.some(child => child !== el && el.contains(child)));
    return !base.querySelector('pre,button,input,textarea,[role="button"],[role="log"],[data-testid="tool-result"],[data-testid="tool-call"]') && !base.closest(CODE_EXCLUDED) ? [base] : [];
  }
  function messageRoots() {
    return [['user', USER_ROOT], ['assistant', ROOT]].flatMap(([role, selector]) => {
      let candidates = [...document.querySelectorAll(selector)].filter(el => !el.closest('[data-czt-owned]'));
      if (codePage() && role === 'assistant' && !candidates.length) candidates = [...document.querySelectorAll('.standard-markdown,.progressive-markdown')].filter(el => !el.closest(CODE_EXCLUDED + ',' + USER_ROOT));
      // Tool use can split a single assistant message into several separate
      // markdown blocks. Each block has its own lifecycle and persistent cache.
      const surfaces = candidates.filter(el => !candidates.some(parent => parent !== el && parent.contains(el)));
      const roots = surfaces.flatMap(el => {
        const selector = role === 'user' ? '.whitespace-pre-wrap,.standard-markdown' : '.standard-markdown,.progressive-markdown';
        const blocks = (el.matches(selector) ? [el] : [...el.querySelectorAll(selector)]).filter(block => !block.closest('[data-czt-owned]'));
        if (blocks.length) return blocks.filter(block => !blocks.some(parent => parent !== block && parent.contains(block)));
        return candidates.filter(child => (child === el || el.contains(child)) && !candidates.some(nested => nested !== child && child.contains(nested)));
      });
      return [...new Set(codePage() && role === 'assistant' ? roots.flatMap(codeProseRoots) : roots)].map(root => ({root, role}));
    });
  }
  function scan() {
    if (route !== location.href) {
      self.CztSidebarTranslator?.clear();
      route = location.href; sendEpoch++; activation++; cancelPending?.();
      for (const record of records.values()) clearView(record);
      records.clear();
    }
    if (!isChatPage()) { deactivate(); return; }
    if (!chatActive) {
      chatActive = true; inComposition = false;
      const started = ++activation;
      createUI();
      observer?.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-is-streaming','aria-busy'] });
      engine.initialize().then(() => {
        if (!chatActive || activation !== started || !isChatPage()) return;
        status('DeepSeek V4.1 Flash · 思考关闭'); scan();
      }).catch(() => { /* Cached messages work without a Key. Prompt only on a send. */ });
    }
    createUI();
    const roots = messageRoots(), current = new Set(roots.map(item => item.root));
    for (const [root, record] of records) if (!root.isConnected || !current.has(root)) { clearView(record); records.delete(root); }
    if (!settings.output) { self.CztSidebarTranslator?.scan(settings.titles); return; }
    const pending = [];
    let stabilizing = false;
    for (const {root, role} of roots) {
      let record = records.get(root);
      const text = root.textContent;
      if (!text.trim()) continue;
      if (!record) {
        record = { root, role, text, changed: Date.now(), busy: false };
        records.set(root, record);
      }
      if (record.text !== text) {
        clearView(record);
        Object.assign(record, { text, changed: Date.now(), done: null, error: null, cacheMiss: null, cacheChecked: null });
      }
      if ((role === 'user' || !isStreaming(root)) && !record.busy && record.done !== text && record.error !== text && record.cacheChecked !== text) {
        record.cacheChecked = text;
        void translateReply(record, true);
        stabilizing = true;
        continue;
      }
      if (record.checkingCache || record.preparing) stabilizing = true;
      if ((role === 'user' || !isStreaming(root)) && !record.busy && record.done !== text && record.error !== text && (record.cacheMiss !== text || engine.ready)) {
        if (Date.now() - record.changed < (role === 'user' ? 200 : 1800)) stabilizing = true;
        else pending.push(record);
      }
    }
    // Prepare every stable block together. The backend removes cached/duplicate
    // segments and coalesces these jobs with sidebar titles into one API call.
    self.CztSidebarTranslator?.scan(settings.titles, !stabilizing && !pending.length);
    if (!stabilizing && pending.length) {
      const atRoute = location.href;
      const batch = replyBatch(pending, () => {
        if (chatActive && atRoute === location.href) self.CztSidebarTranslator?.scan(settings.titles);
      });
      for (const record of pending) void translateReply(record, false, batch);
    }
  }
  function createUI() {
    if (!chatActive || !isChatPage() || ui?.isConnected) return;
    ui = document.createElement('aside'); ui.dataset.cztOwned = 'notice'; ui.hidden = true;
    const shadow = ui.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{position:fixed;right:16px;bottom:16px;z-index:2147483646;color-scheme:light dark}
      :host([hidden]){display:none!important}*{box-sizing:border-box}
      section{max-width:min(360px,calc(100vw - 32px));padding:12px 14px;border:1px solid #8885;border-radius:8px;background:light-dark(#fff,#242422);color:light-dark(#333,#eee);font:13px/1.5 system-ui,sans-serif;box-shadow:0 2px 12px #0001}
      p{margin:0 0 8px;overflow-wrap:anywhere}nav{display:flex;gap:14px}button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0}button:hover{text-decoration:underline}button:focus-visible{outline:2px solid currentColor;outline-offset:3px}#dismiss{margin-left:auto}
    </style><section><p role="status" aria-live="polite"></p><nav><button id="retry" type="button">重试</button><button id="configure" type="button">设置</button><button id="dismiss" type="button" aria-label="关闭提示">×</button></nav></section>`;
    stateLabel = shadow.querySelector('[role="status"]');
    shadow.getElementById('configure').addEventListener('click', () => {
      if (ensureChatActive()) engine.openSettings().catch(error => status(error.message, true));
    });
    shadow.getElementById('retry').addEventListener('click', async () => {
      if (!ensureChatActive()) return;
      status('', false, true);
      try {
        await engine.retryFailed();
        self.CztSidebarTranslator?.retry();
        for (const record of records.values()) { record.error = null; record.cacheMiss = null; }
        scan();
      } catch (error) { status(error.message, true); }
    });
    shadow.getElementById('dismiss').addEventListener('click', () => { ui.hidden = true; });
    document.body.append(ui);
  }
  function applySettings(next) {
    if(typeof next?.output==='boolean'&&next.titles===undefined)next={...next,titles:next.output};
    for (const key of ['input', 'output','titles','chat','code']) {
      if (typeof next?.[key] !== 'boolean' || settings[key] === next[key]) continue;
      settings[key] = next[key];
      if (key === 'input') { sendEpoch++; if (!settings.input) cancelPending?.(); }
      if (key === 'output') for (const record of records.values()) { clearView(record); record.done = null; }
    }
  }
  async function boot() {
    if (initialized) return; initialized = true;
    try { applySettings((await chrome.storage.local.get('cztSettings')).cztSettings); } catch { /* Defaults remain active. */ }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.cztSettings) { applySettings(changes.cztSettings.newValue); scan(); }
      if (changes.cztRefreshAt && chatActive && isChatPage()) {
        sendEpoch++;cancelPending?.();
        for(const record of records.values())clearView(record);
        records.clear();self.CztSidebarTranslator?.clear();
        engine.initialize().then(() => {
          if (!chatActive || !isChatPage()) return;
          for (const record of records.values()) { record.error = null; record.cacheMiss = null; }
          self.CztSidebarTranslator?.retry();
          status('', false, true); scan();
        }).catch(() => { /* The settings page reports configuration errors. */ });
      }
    });
    observer = new MutationObserver(mutations => {
      if (mutations.every(m => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('[data-czt-owned]'))) return;
      clearTimeout(scanTimer); scanTimer = setTimeout(scan, 200);
    });
    window.addEventListener('popstate', scan);
    window.addEventListener('hashchange', scan);
    window.navigation?.addEventListener('currententrychange', scan);
    setInterval(scan, 900);
    scan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else void boot();
})();
