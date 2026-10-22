(() => {
  'use strict';
  const han = /\p{Script=Han}/u;
  // A dollar amount followed by prose is currency, not an opening math fence.
  // Also reject a closing fence immediately followed by another amount.
  const protectedPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|https?:\/\/[^\s<>]+|\$\$[\s\S]*?\$\$|\$(?!\d[\d,]*(?:\.\d+)?(?:\s+[A-Za-z]{2,}|[),.;:]|$))[^$\n]+\$(?!\d)|\]\([^\n)]+\))/g;
  let ready = false;
  async function rpc(message) {
    if (!self.CztChatScope.isChatURL(location.href)) {
      const error = new Error('翻译只在 Claude 聊天页面启用。'); error.code = 'OUTSIDE_CHAT'; throw error;
    }
    let result;
    try { result = await chrome.runtime.sendMessage(message); }
    catch { ready = false; throw new Error('插件连接已断开，请刷新 Claude 网页后重试。'); }
    if (!result?.ok) {
      if (result?.code === 'NO_KEY') ready = false;
      const error = new Error(result?.error || 'DeepSeek 后台未响应，请重新加载插件并刷新页面。');
      error.code = result?.code; throw error;
    }
    return result;
  }
  async function initialize() {
    const result = await rpc({ type: 'CZT_STATUS' });
    if (!result.configured) throw new Error('请点击“配置 DeepSeek”，在插件设置中填入 API Key。');
    ready = true;
  }
  function needsTranslation(text, direction) {
    if (direction === 'zh:en') return han.test(text);
    const chinese = (text.match(/\p{Script=Han}/gu) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    return latin >= 2 && latin > chinese * 2;
  }
  async function translateMany(texts, direction) {
    const segments = [];
    const templates = texts.map(text => text.split(protectedPattern).flatMap((part, index) => {
      if (index % 2 || !needsTranslation(part, direction)) return [part];
      return (part.match(/[^\n]{1,1800}|\n+/g) || []).map(chunk => {
        if (!needsTranslation(chunk, direction)) return chunk;
        const [, before, body, after] = chunk.match(/^(\s*)([\s\S]*?)(\s*)$/);
        const id = segments.push(body) - 1;
        return { id, before, after };
      });
    }));
    if (!segments.length) return [...texts];
    // A whole page may exceed IPC validation limits. Submit transport groups
    // together; the backend still coalesces/cache-filters them before the LLM.
    const groups = []; let group = [], length = 0;
    for (const segment of segments) {
      if (group.length && (group.length >= 1000 || length + segment.length > 160000)) { groups.push(group); group = []; length = 0; }
      group.push(segment); length += segment.length;
    }
    if (group.length) groups.push(group);
    const results = await Promise.all(groups.map(texts => rpc({ type: 'CZT_TRANSLATE', texts, direction })));
    const translations = results.flatMap(result => result.translations);
    if (!Array.isArray(translations) || translations.length !== segments.length) throw new Error('DeepSeek 返回的译文数量不匹配，已保留原文。');
    return templates.map(parts => parts.map(part => typeof part === 'string' ? part : part.before + translations[part.id].trim() + part.after).join(''));
  }
  async function translate(text, direction) { return (await translateMany([text], direction))[0]; }
  function needsProseTranslation(text, direction) {
    return text.split(protectedPattern).some((part, index) => index % 2 === 0 && needsTranslation(part, direction));
  }
  self.ClaudeZhTranslator = { initialize, translate, translateMany, needsTranslation, needsProseTranslation,
    rememberOriginal: (english, original) => rpc({ type: 'CZT_ORIGINAL_PUT', english, original }),
    getOriginal: async english => (await rpc({ type: 'CZT_ORIGINAL_GET', english })).original,
    getView: async (source, role) => (await rpc({ type: 'CZT_VIEW_GET', source, role })).view,
    saveView: (source, role, view) => rpc({ type: 'CZT_VIEW_PUT', source, role, view }),
    retryFailed: () => rpc({ type: 'CZT_RETRY_FAILED' }),
    openSettings: () => rpc({ type: 'CZT_OPEN_OPTIONS' }), get ready() { return ready; } };
})();
