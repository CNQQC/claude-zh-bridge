(() => {
  'use strict';
  const status = document.querySelector('#status'), result = document.querySelector('#result');
  const show = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  async function rpc(message) {
    const data = await chrome.runtime.sendMessage(message);
    if (!data?.ok) throw new Error(data?.error || '插件后台未响应。');
    return data;
  }
  let settings = { input: true, output: true };
  const refresh = () => chrome.storage.local.set({ cztRefreshAt: Date.now() });
  for (const key of ['input', 'output']) document.getElementById(key).addEventListener('change', async event => {
    settings[key] = event.currentTarget.checked;
    try { await chrome.storage.local.set({ cztSettings: settings }); show('设置已更新。'); }
    catch (error) { show(error.message, true); }
  });
  document.querySelector('#retry').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await rpc({ type: 'CZT_RETRY_FAILED' }); await refresh(); show('已重试未完成的翻译，成功缓存保持不变。'); }
    catch (error) { show(error.message, true); }
    finally { button.disabled = false; }
  });
  async function load() {
    try {
      settings = { ...settings, ...(await chrome.storage.local.get('cztSettings')).cztSettings };
      for (const key of ['input', 'output']) document.getElementById(key).checked = settings[key];
    } catch (error) { show(error.message, true); }
    try { const data = await rpc({ type: 'CZT_STATUS' }); show(data.configured ? 'Key 已配置，本次浏览器会话有效。' : '请填写自己的 DeepSeek API Key。已有译文可直接从本机恢复。'); }
    catch (error) { show(error.message, true); }
  }
  document.querySelector('#settings').addEventListener('submit', async event => {
    event.preventDefault(); const button = document.querySelector('#save'); button.disabled = true;
    const input = document.querySelector('#key'), apiKey = input.value; input.value = '';
    show('正在验证 Key 和翻译模型…'); result.hidden = true;
    try { await rpc({ type: 'CZT_CONFIG_SET', apiKey }); await refresh(); show('已启用翻译，思考关闭。返回 Claude 网页即可使用。'); }
    catch (error) { show(error.message, true); }
    finally { button.disabled = false; }
  });
  document.querySelector('#test').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; show('正在测试中英双向翻译…'); result.hidden = true;
    try {
      const english = await rpc({ type: 'CZT_TRANSLATE', direction: 'zh:en', texts: ['你好，请用一句话解释什么是机器学习。'] });
      const chinese = await rpc({ type: 'CZT_TRANSLATE', direction: 'en:zh', texts: ['Translation works directly inside the Claude webpage.'] });
      result.textContent = `中文 → 英文\n${english.translations[0]}\n\n英文 → 中文\n${chinese.translations[0]}\n\n请求模型：${chinese.metadata.requestedModel}\n返回模型：${chinese.metadata.returnedModel}\n思考开关：disabled\n思考 tokens：${chinese.metadata.reasoningTokens ?? '接口未提供'}`;
      result.hidden = false; show('双向翻译测试成功。');
    } catch (error) { show(error.message, true); }
    finally { button.disabled = false; }
  });
  document.querySelector('#clear').addEventListener('click', async () => {
    try { await rpc({ type: 'CZT_CONFIG_CLEAR' }); await refresh(); result.hidden = true; document.querySelector('#key').value = ''; show('Key 已清除。已有译文仍可使用。'); }
    catch (error) { show(error.message, true); }
  });
  void load();
})();
