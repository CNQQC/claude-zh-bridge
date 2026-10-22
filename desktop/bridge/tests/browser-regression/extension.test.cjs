const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const base = path.resolve(__dirname, '../../extension');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (check()) return; await pause(10); }
  throw new Error(message || 'Condition timed out');
}
async function fixture(options = {}) {
  const dom = new JSDOM(`<!doctype html><body><main><div class="font-claude-response"><div class="standard-markdown"><p>Hello world. <strong>Good morning.</strong></p><pre><code>print("hello")</code></pre></div></div><form><div class="ProseMirror" role="textbox" contenteditable="true">你好</div><button type="button" aria-label="Send message">Send</button></form></main></body>`, { url: options.url || 'https://claude.ai/chat/test', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], sent = [], messages = [];
  if (options.messagesHTML) w.document.querySelector('.font-claude-response').outerHTML = options.messagesHTML;
  if (options.noMessages) w.document.querySelector('.font-claude-response').remove();
  const cacheState = options.cacheState || { views:new Map(), originals:new Map() };
  const form = w.document.querySelector('form');
  if (options.composerHTML) form.innerHTML = options.composerHTML;
  w.HTMLElement.prototype.getClientRects = () => [{ width: 100 }];
  const realNow = Date.now;
  w.Date.now = () => realNow() * 100;
  const timeout = w.setTimeout.bind(w), interval = w.setInterval.bind(w);
  w.setTimeout = (fn, ms) => timeout(fn, Math.min(ms, 10));
  w.setInterval = (fn, ms) => interval(fn, Math.min(ms, 20));
  let saved = options.settings || {};
  const storageListeners = [];
  w.chrome = { storage: { onChanged: { addListener: fn => storageListeners.push(fn) }, local: { get: async () => ({ cztSettings: saved }), set: async value => { saved = value.cztSettings; } } }, runtime: { sendMessage: async message => {
    messages.push(message);
    if (options.worker) {
      if (message.type === 'CZT_VIEW_GET' && options.cacheDelay) await pause(options.cacheDelay(message));
      return options.worker.send(message, w.location.href);
    }
    if (message.type === 'CZT_STATUS') return { ok: true, configured: !options.unsupported };
    if (message.type === 'CZT_OPEN_OPTIONS' || message.type === 'CZT_RETRY_FAILED') return { ok: true };
    if (message.type === 'CZT_ORIGINAL_PUT') { cacheState.originals.set(message.english, message.original); return {ok:true}; }
    if (message.type === 'CZT_ORIGINAL_GET') return {ok:true,original:cacheState.originals.get(message.english)||null};
    if (message.type === 'CZT_VIEW_PUT') { cacheState.views.set(message.role+':'+message.source, message.view); return {ok:true}; }
    if (message.type === 'CZT_VIEW_GET') return {ok:true,view:cacheState.views.get(message.role+':'+message.source)||null};
    if (message.type === 'CZT_TRANSLATE') {
      if (options.unsupported) return {ok:false,code:'NO_KEY',error:'Missing DeepSeek key'};
      await pause(options.delay ?? 1);
      if (options.fail) return { ok: false, error: 'DeepSeek request failed' };
      const sourceLanguage = message.direction === 'zh:en' ? 'zh' : 'en';
      return { ok: true, translations: message.texts.map(text => {
        calls.push({ sourceLanguage, text });
        if (sourceLanguage === 'zh') return text.replaceAll('你好', 'Hello').replaceAll('解释', 'Explain');
        return text.replaceAll('Hello world.', '你好，世界。').replaceAll('Good morning.', '早上好。').replaceAll('New response.', '新的回复。');
      }) };
    }
    return { ok: false, error: 'Unknown fixture request' };
  } } };
  w.document.execCommand = (_, __, text) => {
    if (options.writeFails) return false;
    const range = w.getSelection().getRangeAt(0);
    const el = range.commonAncestorContainer;
    el.textContent = text;
    el.dispatchEvent(new w.InputEvent('input', { bubbles: true, data: text }));
    return true;
  };
  const button = form.querySelector('button,[role="button"],input[type="submit"]'), editor = form.querySelector('[contenteditable],textarea');
  button.addEventListener('click', event => {
    event.preventDefault();
    sent.push(editor.tagName === 'TEXTAREA' ? editor.value : editor.textContent);
    if (options.echoMessage) {
      const message = w.document.createElement('div'); message.className = 'font-user-message'; message.textContent = sent.at(-1);
      w.document.querySelector('main').append(message);
    }
    if (editor.tagName === 'TEXTAREA') editor.value = ''; else editor.textContent = '';
  });
  for (const file of ['scope.js','translator.js','sidebar.js','content.js']) w.eval(fs.readFileSync(path.join(base, file), 'utf8'));
  if (options.expectInactive) await pause(30);
  else await until(() => w.document.querySelector('[data-czt-owned="notice"]'));
  const panel = w.document.querySelector('[data-czt-owned="notice"]')?.shadowRoot;
  return { dom, w, panel, calls, sent, editor, button, cacheState, messages, setSettings: async next => { saved = {input:true,output:true,...saved,...next}; storageListeners.forEach(fn => fn({cztSettings:{newValue:saved}},'local')); await pause(1); }, enable: async () => { await until(() => w.ClaudeZhTranslator.ready); } };
}
async function withFixture(options, fn) { const f = await fixture(options); try { await fn(f); } finally { f.dom.window.close(); } }

test('Code scope can be disabled independently without intercepting prompts',()=>withFixture({url:'https://claude.ai/epitaxy',settings:{code:false,chat:true},expectInactive:true},async f=>{
 assert.equal(f.panel,undefined);f.button.click();await pause(30);assert.equal(f.sent[0],'你好');assert.equal(f.calls.length,0);
}));

test('Desktop Code intercepts Chinese button and Enter sends on epitaxy routes', async () => {
  for (const route of ['/epitaxy','/epitaxy/session-123']) await withFixture({url:'https://claude.ai'+route,noMessages:true},async f=>{
    f.editor.textContent='解释 `const x = 1`';f.button.click();
    await until(()=>f.sent.length===1);assert.equal(f.sent[0],'Explain `const x = 1`');
    f.editor.textContent='你好';f.editor.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    await until(()=>f.sent.length===2);assert.equal(f.sent[1],'Hello');
  });
});

test('Desktop Code translates prose after tools without replacing code or permission controls',()=>withFixture({url:'https://claude.ai/epitaxy/session-123',messagesHTML:'<div data-message-role="assistant"><div class="standard-markdown"><h2 class="sr-only">Claude responded: Hello world.</h2><p>Hello world.</p><pre><code>const value = "English code";</code><button id="copy-code">Copy code</button></pre><div data-testid="tool-result"><p>Tool execution output</p><button id="approve">Allow</button></div></div></div>'},async f=>{
  const code=f.w.document.querySelector('pre'),approve=f.w.document.querySelector('#approve');let clicked=0;approve.onclick=()=>clicked++;
  await until(()=>f.w.document.querySelector('.czt-translation'));
  assert.match(f.w.document.querySelector('.czt-translation').textContent,/你好，世界/);
  assert.equal(f.w.document.querySelector('pre'),code);assert(!code.closest('[data-czt-original-hidden]'));
  assert.equal(f.w.document.querySelector('#approve'),approve);approve.click();assert.equal(clicked,1);
  assert(!f.calls.some(c=>/English code|execution output|Allow|Claude responded/.test(c.text)));
  const next=f.w.document.createElement('div');next.className='progressive-markdown';next.innerHTML='<p>New response.</p>';f.w.document.querySelector('[data-message-role="assistant"]').append(next);
  await until(()=>[...f.w.document.querySelectorAll('.czt-translation')].some(el=>el.textContent==='新的回复。'));
}));

test('Desktop Code markdown fallback leaves tool output alone and restores on leaving Code',()=>withFixture({url:'https://claude.ai/epitaxy',messagesHTML:'<section><div class="standard-markdown"><p>Hello world.</p></div><div data-testid="tool-result"><div class="standard-markdown"><p>Tool output should remain</p></div></div></section>'},async f=>{
  await until(()=>f.w.document.querySelector('.czt-translation'));
  assert.equal(f.w.document.querySelectorAll('.czt-translation').length,1);
  f.w.history.pushState({},'','/settings');f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));
  await until(()=>!f.w.document.querySelector('.czt-translation'));
  assert(!f.w.document.querySelector('[data-czt-original-hidden]'));
}));

test('Code heading, list and table snapshots restore after reload without another paid request',async()=>{
  const cacheState={views:new Map(),originals:new Map()};
  const options={url:'https://claude.ai/epitaxy/session-123',cacheState,messagesHTML:'<div data-message-role="assistant"><div class="standard-markdown"><h2>Hello world.</h2><ul><li>Good morning.</li></ul><table><thead><tr><th>New response.</th></tr></thead><tbody><tr><td>Hello world. Detail.</td></tr></tbody></table></div></div>'};
  await withFixture(options,async f=>{await until(()=>f.w.document.querySelectorAll('.czt-translation').length===4);assert.equal(f.messages.filter(m=>m.type==='CZT_TRANSLATE').length,1);});
  await withFixture({...options,unsupported:true},async f=>{
    await until(()=>f.w.document.querySelectorAll('.czt-translation').length===4);
    assert(!f.messages.some(m=>m.type==='CZT_TRANSLATE'));
    assert.deepEqual([...f.w.document.querySelectorAll('.czt-translation')].map(el=>el.tagName),['H2','LI','TH','TD']);
    assert(f.w.document.querySelector('[data-czt-owned="notice"]').hidden);
  });
});

test('currency prose is translated whole while numeric and symbolic math stay protected', () => withFixture({noMessages:true}, async f => {
  const source = 'It costs $20 per month, about S$27, or $17 per month ($200 billed upfront).';
  await f.w.ClaudeZhTranslator.translate(source, 'en:zh');
  assert.equal(f.calls.at(-1).text, source);
  f.calls.length = 0;
  await f.w.ClaudeZhTranslator.translate('Explain $E=mc^2$ and $2x$ with $x + y$ and `code`.', 'en:zh');
  assert(!f.calls.some(c => /E=mc|2x|x \+ y|`code`/.test(c.text)));
}));

test('old broken currency view is repaired once and the repaired view survives reload without requests', async () => {
  const source = 'It costs $20 per month, about $27 for Singapore.';
  const cacheState = {views:new Map([['assistant:'+source,{html:'<div class="standard-markdown">费用为 $20 per month, about $27 for Singapore.</div>'}]]), originals:new Map()};
  const options = {messagesHTML:`<div class="font-claude-response"><div class="standard-markdown">${source}</div></div>`,cacheState};
  await withFixture(options, async f => {
    await until(()=>f.w.document.querySelector('.czt-translation'));
    assert.equal(f.calls.length,1); assert.equal(f.calls[0].text,source);
    assert.equal(cacheState.views.get('assistant:'+source).currencyFix,1);
  });
  await withFixture(options, async f => {
    await until(()=>f.w.document.querySelector('.czt-translation'));
    assert.equal(f.calls.length,0);
  });
});

test('Chinese button send is translated once; code and URL are unchanged', () => withFixture({}, async f => {
  f.editor.textContent = '你好 `中文代码` https://example.com/中文';
  f.button.click(); f.button.click();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Hello `中文代码` https://example.com/中文');
}));
test('Enter is intercepted; Shift+Enter and IME confirmation pass through', () => withFixture({}, async f => {
  for (const init of [{ shiftKey:true }, { isComposing:true }]) {
    const e = new f.w.KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true, ...init });
    f.editor.dispatchEvent(e); assert.equal(e.defaultPrevented, false);
  }
  f.editor.dispatchEvent(new f.w.KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
  await until(() => f.sent.length === 1); assert.equal(f.sent[0], 'Hello');
}));
test('failed translation preserves Chinese draft and never sends', () => withFixture({fail:true}, async f => {
  f.button.click(); await until(() => f.panel.querySelector('[data-error="true"]'));
  assert.equal(f.editor.textContent, '你好'); assert.equal(f.sent.length, 0);
}));
test('editing a pending draft cancels submission', () => withFixture({delay:40}, async f => {
  f.button.click(); f.editor.textContent = 'New draft';
  f.editor.dispatchEvent(new f.w.Event('input', {bubbles:true}));
  await until(() => f.panel.querySelector('[data-error="true"]'));
  assert.equal(f.editor.textContent, 'New draft'); assert.equal(f.sent.length, 0);
}));
test('SPA navigation cancels a pending send', () => withFixture({delay:40}, async f => {
  f.button.click(); f.w.history.pushState({}, '', '/new');
  await until(() => f.panel.querySelector('[data-error="true"]'));
  assert.equal(f.sent.length, 0); assert.equal(f.editor.textContent, '你好');
}));
test('reply replaces display, preserves formatting/code, toggles original, restores when disabled', () => withFixture({}, async f => {
  await f.enable();
  await until(() => f.w.document.querySelector('.czt-translation'));
  const original = f.w.document.querySelector('.standard-markdown:not(.czt-translation)');
  const view = f.w.document.querySelector('.czt-translation');
  assert.match(view.textContent, /你好，世界/); assert.equal(view.querySelector('strong').textContent, '早上好。');
  assert.equal(view.querySelector('code').textContent, 'print("hello")');
  assert.match(original.textContent, /Hello world/); assert(original.hasAttribute('data-czt-original-hidden'));
  assert(!f.calls.some(c => c.text.includes('print')));
  f.w.document.querySelector('.czt-controls button').click();
  assert.equal(view.hidden, true); assert(!original.hasAttribute('data-czt-original-hidden'));
  await f.setSettings({output:false});
  assert.equal(f.w.document.querySelector('.czt-translation'), null);
}));
test('streaming replies are translated only after completion; regeneration invalidates overlay', () => withFixture({}, async f => {
  const root = f.w.document.querySelector('.font-claude-response'); root.dataset.isStreaming = 'true';
  await f.enable(); await pause(90); assert.equal(f.w.document.querySelector('.czt-translation'), null);
  root.dataset.isStreaming = 'false';
  await until(() => f.w.document.querySelector('.czt-translation'));
  const original = f.w.document.querySelector('.standard-markdown:not(.czt-translation)');
  original.querySelector('p').textContent = 'New response.';
  await until(() => f.w.document.querySelector('.czt-translation')?.textContent.includes('新的回复'));
  assert.equal(f.w.document.querySelectorAll('.czt-translation').length, 1);
}));
test('missing DeepSeek configuration fails visibly without sending', () => withFixture({unsupported:true}, async f => {
  f.button.click(); await until(() => f.panel.querySelector('[data-error="true"]'));
  assert.equal(f.sent.length, 0); assert.equal(f.editor.textContent, '你好');
}));
test('English inputs and disabled input translation use native send', () => withFixture({settings:{input:false}}, async f => {
  f.button.click(); assert.equal(f.sent[0], '你好'); assert.equal(f.calls.length, 0);
  f.editor.textContent = 'Hello'; await f.setSettings({input:true}); f.button.click();
  assert.equal(f.sent[1], 'Hello');
}));
test('editor write rejection cancels send', () => withFixture({writeFails:true}, async f => {
  f.button.click(); await until(() => f.panel.querySelector('[data-error="true"]'));
  assert.equal(f.sent.length, 0); assert.equal(f.editor.textContent, '你好');
}));
test('disabling input translation cancels pending work and releases native send', () => withFixture({delay:300}, async f => {
  f.button.click(); await f.setSettings({input:false});
  await until(() => f.panel.querySelector('[data-error="true"]'));
  f.button.click(); assert.deepEqual(f.sent, ['你好']);
}));
test('form submission also passes through the translation guard', () => withFixture({}, async f => {
  const event = new f.w.Event('submit', {bubbles:true,cancelable:true});
  f.w.document.querySelector('form').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  await until(() => f.sent.length === 1); assert.equal(f.sent[0], 'Hello');
}));
test('unlabelled submit button cannot send Chinese past the translation guard', () => withFixture({composerHTML:'<div contenteditable="true" data-testid="chat-input">你好</div><button type="submit"><span>↑</span></button>'}, async f => {
  f.button.querySelector('span').click();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0], 'Hello');
}));
test('new send labels and nested icon clicks are intercepted', () => withFixture({composerHTML:'<div contenteditable="true" role="textbox">你好</div><button aria-label="Send prompt"><span>↑</span></button>'}, async f => {
  f.button.querySelector('span').click();
  await until(() => f.sent.length === 1); assert.equal(f.sent[0], 'Hello');
}));
test('role buttons and plaintext-only editor attributes are supported', () => withFixture({composerHTML:'<div contenteditable="plaintext-only" data-testid="chat-input">你好</div><div role="button" aria-label="Send message"><span>↑</span></div>'}, async f => {
  f.button.querySelector('span').click();
  await until(() => f.sent.length === 1); assert.equal(f.sent[0], 'Hello');
}));
test('routine translation has no visible panel, banners or progress messages', () => withFixture({}, async f => {
  await until(() => f.w.document.querySelector('.czt-translation'));
  assert.equal(f.w.document.querySelector('[data-czt-owned="notice"]').hidden, true);
  assert.equal(f.panel.querySelector('header,input'), null);
  assert.equal(f.w.document.querySelector('.czt-controls').textContent, 'EN');
  assert.equal(f.w.document.querySelector('.czt-controls button').getAttribute('aria-label'), '查看英文原文');
  assert(!f.w.document.body.textContent.includes('已保存'));
}));
test('textarea input uses its native value setter before submission', () => withFixture({composerHTML:'<textarea placeholder="Message Claude">你好</textarea><button type="submit">↑</button>'}, async f => {
  f.button.click(); await until(() => f.sent.length === 1); assert.equal(f.sent[0], 'Hello');
}));
test('background reply translation does not hide an input failure', () => withFixture({writeFails:true}, async f => {
  f.button.click(); await pause(100);
  assert.equal(f.sent.length,0);
  assert.equal(f.panel.querySelector('[role="status"]').getAttribute('data-error'),'true');
  assert.match(f.panel.querySelector('[role="status"]').textContent,/不支持安全替换/);
}));
test('sent English messages display the saved Chinese input without a reverse API call',()=>withFixture({echoMessage:true},async f=>{
  f.button.click();await until(()=>f.sent.length===1);
  await until(()=>f.w.document.querySelector('.font-user-message[data-czt-original-hidden]'));
  const source=f.w.document.querySelector('.font-user-message[data-czt-original-hidden]');
  assert.equal(source.textContent,'Hello');assert.equal(source.nextElementSibling.textContent,'你好');
  assert(!f.calls.some(call=>call.sourceLanguage==='en'&&call.text==='Hello'));
  assert.equal(f.cacheState.originals.get('Hello'),'你好');
}));
test('a fresh document restores saved replies with no Key and makes no translation requests',async()=>{
  const cacheState={views:new Map(),originals:new Map()};
  await withFixture({cacheState},async f=>{await until(()=>f.w.document.querySelector('.czt-translation'));assert(f.calls.length>0);});
  await withFixture({cacheState,unsupported:true},async f=>{
    await until(()=>f.w.document.querySelector('.czt-translation'));assert.equal(f.calls.length,0);
    assert.match(f.w.document.querySelector('.czt-translation').textContent,/你好，世界/);
    assert(!f.messages.some(message=>message.type==='CZT_TRANSLATE'));
  });
});
test('SPA conversation switches and recreated message nodes restore cached views without new API calls',()=>withFixture({},async f=>{
  await until(()=>f.w.document.querySelector('.czt-translation'));
  const before=f.calls.length;
  const source=f.w.document.querySelector('.standard-markdown:not(.czt-translation)');
  const parent=source.parentElement,html=source.innerHTML;
  f.w.history.pushState({},'','/chat/another');parent.replaceChildren();
  const root=f.w.document.createElement('div');root.className='standard-markdown';root.innerHTML=html;parent.append(root);
  await until(()=>root.hasAttribute('data-czt-original-hidden'));
  assert.equal(f.calls.length,before);assert.match(root.nextElementSibling.textContent,/你好，世界/);
}));
test('cache restoration survives different text-node segmentation',()=>withFixture({},async f=>{
  await until(()=>f.w.document.querySelector('.czt-translation'));
  const source=f.w.document.querySelector('.standard-markdown:not(.czt-translation)'),before=f.calls.length;
  const root=f.w.document.createElement('div');root.className='standard-markdown';root.innerHTML=source.innerHTML.replace('Hello world.','<span>Hello </span>world.');
  f.w.history.pushState({},'','/chat/other');source.replaceWith(root);
  await until(()=>root.hasAttribute('data-czt-original-hidden'));
  assert.equal(f.calls.length,before);assert.match(root.nextElementSibling.textContent,/你好，世界/);
}));
test('sent message Chinese display survives a reload without a Key',async()=>{
  const cacheState={views:new Map(),originals:new Map()};
  await withFixture({cacheState,echoMessage:true},async f=>{
    f.button.click();await until(()=>f.w.document.querySelector('.font-user-message[data-czt-original-hidden]'));
  });
  await withFixture({cacheState,unsupported:true},async f=>{
    const source=f.w.document.createElement('div');source.className='font-user-message';source.textContent='Hello';f.w.document.querySelector('main').append(source);
    await until(()=>source.hasAttribute('data-czt-original-hidden'));
    assert.equal(source.nextElementSibling.textContent,'你好');assert.equal(f.calls.length,0);
  });
});
test('complete content/background/cache integration restores both roles after a reload with zero API requests',async()=>{
  const {createBackground}=require('./background-harness.cjs');
  const localStore={},requests=[];
  const fetcher=async(_,options)=>{
    const body=JSON.parse(options.body),texts=JSON.parse(body.messages[1].content).texts;requests.push(texts);
    const english=body.messages[0].content.includes('into English.');
    const translations=texts.map(text=>english?text.replaceAll('你好','Hello'):text.replaceAll('Hello world.','你好，世界。').replaceAll('Good morning.','早上好。'));
    return{ok:true,status:200,json:async()=>({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations})}}]})};
  };
  const first=createBackground({initialKey:'sk-fixture-integration-key',localStore,fetch:fetcher});
  await withFixture({worker:first,echoMessage:true},async f=>{
    f.button.click();await until(()=>f.w.document.querySelectorAll('.czt-translation').length===2);
    assert.equal(f.sent[0],'Hello');assert.equal(requests.length,2);
  });
  const before=requests.length,second=createBackground({localStore,fetch:fetcher});
  await withFixture({worker:second},async f=>{
    const user=f.w.document.createElement('div');user.className='font-user-message';user.textContent='Hello';f.w.document.querySelector('main').append(user);
    await until(()=>f.w.document.querySelectorAll('.czt-translation').length===2);
    assert.equal(user.nextElementSibling.textContent,'你好');assert.equal(requests.length,before);
    assert.equal((await second.send({type:'CZT_STATUS'})).configured,false);
  });
});
for(const route of ['/settings','/settings/profile','/projects','/project/abc','/login','/recents','/artifacts','/share/abc'])test(`non-chat page ${route} never creates UI, intercepts sending or calls the background`,()=>withFixture({url:'https://claude.ai'+route,expectInactive:true},async f=>{
  assert.equal(f.w.document.querySelector('[data-czt-owned]'),null);
  const enter=new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});f.editor.dispatchEvent(enter);assert.equal(enter.defaultPrevented,false);
  f.button.click();await pause(40);assert.deepEqual(f.sent,['你好']);assert.equal(f.messages.length,0);assert.equal(f.calls.length,0);
  assert.equal(f.w.document.querySelector('[data-czt-original-hidden]'),null);
}));
test('the home URL is enabled for its actual chat composer',()=>withFixture({url:'https://claude.ai/'},async f=>{
  f.button.click();await until(()=>f.sent.length===1);assert.equal(f.sent[0],'Hello');
}));
test('a signed-out home page with a newsletter textarea does not activate',()=>withFixture({url:'https://claude.ai/',expectInactive:true,noMessages:true,composerHTML:'<textarea placeholder="Email address">你好</textarea><button type="button">Subscribe</button>'},async f=>{
  assert.equal(f.w.document.querySelector('[data-czt-owned]'),null);f.button.click();await pause(30);assert.equal(f.messages.length,0);assert.deepEqual(f.sent,['你好']);
}));
test('SPA exit restores originals and removes UI; returning to chat reuses saved translations',()=>withFixture({},async f=>{
  await until(()=>f.w.document.querySelector('.czt-translation'));
  const before=f.calls.length;
  f.w.history.pushState({},'','/settings/profile');
  await until(()=>!f.w.document.querySelector('[data-czt-owned="notice"]'));
  assert.equal(f.w.document.querySelector('.czt-translation'),null);assert.equal(f.w.document.querySelector('[data-czt-original-hidden]'),null);
  const paused=f.messages.length;await pause(80);assert.equal(f.messages.length,paused);
  f.w.history.pushState({},'','/chat/test');f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));
  await until(()=>f.w.document.querySelector('.czt-translation'));
  assert(f.w.document.querySelector('[data-czt-owned="notice"]'));assert.equal(f.calls.length,before);
}));
test('direct non-chat entry can later activate through an SPA route into a conversation',()=>withFixture({url:'https://claude.ai/settings',expectInactive:true},async f=>{
  assert.equal(f.messages.length,0);
  f.w.history.pushState({},'','/chat/test');f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));
  await until(()=>f.w.document.querySelector('[data-czt-owned="notice"]'));
  f.button.click();await until(()=>f.sent.length===1);assert.equal(f.sent[0],'Hello');
}));
test('an immediate send on a non-chat route bypasses the extension before the route polling tick',()=>withFixture({},async f=>{
  f.w.history.pushState({},'','/settings');
  f.button.click();assert.equal(f.sent[0],'你好');assert.equal(f.w.document.querySelector('[data-czt-owned="notice"]'),null);
  assert(!f.messages.some(message=>message.type==='CZT_TRANSLATE'&&message.direction==='zh:en'));
}));
test('a pending input translation cannot write or submit after leaving chat',()=>withFixture({delay:100},async f=>{
  f.button.click();f.w.history.pushState({},'','/settings');f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));
  await pause(150);assert.equal(f.sent.length,0);assert.equal(f.editor.textContent,'你好');assert.equal(f.w.document.querySelector('[data-czt-owned]'),null);
}));
test('a pending assistant translation cannot reinsert overlays or issue follow-up requests on a non-chat page',()=>withFixture({delay:100},async f=>{
  await until(()=>f.messages.some(message=>message.type==='CZT_TRANSLATE'&&message.direction==='en:zh'));
  f.w.history.pushState({},'','/project/abc');f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));
  const before=f.messages.length;await pause(140);
  assert.equal(f.w.document.querySelector('[data-czt-owned]'),null);assert.equal(f.messages.length,before);
}));

const toolMessage = `<div data-testid="assistant-message"><div class="font-claude-response"><div class="prose"><div class="standard-markdown"><p>Hello world.</p></div></div><div data-testid="tool-result"><button>Searched the web</button></div><div class="prose"><div class="progressive-markdown"><p>New response.</p><pre><code>const value = "English code";</code></pre></div></div></div><div role="toolbar"><button>Copy</button></div></div>`;
test('actual Claude tool-use structure translates every independent body block and preserves tool UI',()=>withFixture({messagesHTML:toolMessage},async f=>{
  await until(()=>f.w.document.querySelectorAll('.czt-translation').length===2);
  const views=[...f.w.document.querySelectorAll('.czt-translation')];
  assert.match(views[0].textContent,/你好，世界/);assert.match(views[1].textContent,/新的回复/);
  assert.equal(views[1].querySelector('code').textContent,'const value = "English code";');
  assert.equal(f.w.document.querySelector('[data-testid="tool-result"] button').textContent,'Searched the web');
  assert.equal(f.w.document.querySelector('[role="toolbar"] button').textContent,'Copy');
  assert.equal(f.w.document.querySelectorAll('[data-czt-original-hidden]').length,2);
  assert.equal(f.w.document.querySelectorAll('.czt-controls').length,2);
  assert(!f.calls.some(call=>/Searched|Copy|English code/.test(call.text)));
  assert.equal(f.messages.filter(message=>message.type==='CZT_TRANSLATE').length,1);
}));

test('all Code paragraphs and sidebar titles use one paid request even with slow per-block cache reads',async()=>{
  const {createBackground}=require('./background-harness.cjs'),localStore={},requests=[];
  const worker=createBackground({initialKey:'sk-fixture-batch-code-key',localStore,fetch:async(_,options)=>{
    const texts=JSON.parse(JSON.parse(options.body).messages[1].content).texts;requests.push(texts);
    return{ok:true,status:200,json:async()=>({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(text=>'中文：'+text)})}}]})};
  }});
  const blocks=Array.from({length:70},(_,i)=>`<p>Paragraph number ${i}.</p>`).join('');
  const messagesHTML='<div data-message-role="assistant"><div class="standard-markdown">'+blocks+'<pre><code>English code</code><button>Copy</button></pre></div></div>';
  const options={url:'https://claude.ai/epitaxy/session-123',messagesHTML,worker,cacheDelay:message=>message.source==='Paragraph number 69.'?230:0};
  await withFixture(options,async f=>{
    f.w.document.body.insertAdjacentHTML('afterbegin','<aside aria-label="Sidebar"><a href="/chat/one"><span class="truncate">Session title</span></a></aside>');
    await until(()=>f.w.document.querySelectorAll('.czt-translation').length===70);
    await until(()=>f.w.document.querySelector('aside .truncate').textContent==='中文：Session title');
    assert.equal(requests.length,1);assert.equal(requests[0].length,71);
    assert.equal(f.w.document.querySelector('pre code').textContent,'English code');
    await pause(100);assert.equal(requests.length,1);
  });
  const restarted=createBackground({localStore,fetch:async()=>{throw new Error('Cache must avoid API');}});
  await withFixture({...options,worker:restarted,cacheDelay:null},async f=>{
    await until(()=>f.w.document.querySelectorAll('.czt-translation').length===70);
    assert.equal(f.messages.filter(message=>message.type==='CZT_TRANSLATE').length,0);
  });
});
test('new blocks appended after completed tool rounds are translated once without retranslating the preamble',()=>withFixture({},async f=>{
  await until(()=>f.w.document.querySelector('.czt-translation'));
  const before=f.calls.length, wrapper=f.w.document.querySelector('.font-claude-response');
  wrapper.insertAdjacentHTML('beforeend','<div><button>Search again</button></div><div class="progressive-markdown"><p>New response.</p></div>');
  await until(()=>f.w.document.querySelectorAll('.czt-translation').length===2);
  assert.equal(f.calls.slice(before).filter(call=>call.sourceLanguage==='en').length,1);
  assert.equal(f.calls.at(-1).text,'New response.');
  await pause(80);assert.equal(f.calls.length,before+1);
}));
test('multi-block tool replies restore every cached block after reload without a Key or API requests',async()=>{
  const cacheState={views:new Map(),originals:new Map()};
  await withFixture({messagesHTML:toolMessage,cacheState},async f=>{await until(()=>f.w.document.querySelectorAll('.czt-translation').length===2);});
  await withFixture({messagesHTML:toolMessage,cacheState,unsupported:true},async f=>{
    await until(()=>f.w.document.querySelectorAll('.czt-translation').length===2);
    assert.equal(f.calls.length,0);assert(!f.messages.some(m=>m.type==='CZT_TRANSLATE'));
    assert.equal(f.w.document.querySelector('[data-czt-owned="notice"]').hidden,true);
  });
});
test('a visible stop button delays only the current response; completed earlier rounds still translate',()=>withFixture({},async f=>{
  const main=f.w.document.querySelector('main');
  main.insertAdjacentHTML('beforeend','<div data-testid="assistant-message"><div class="font-claude-response"><div class="standard-markdown">New response.</div></div></div><button data-testid="stop-button">Stop</button>');
  await until(()=>f.w.document.querySelector('.czt-translation'));
  assert.match(f.w.document.querySelector('.czt-translation').textContent,/你好，世界/);
  assert.equal(f.w.document.querySelectorAll('.czt-translation').length,1);
  f.w.document.querySelector('[data-testid="stop-button"]').hidden=true;
  await until(()=>f.w.document.querySelectorAll('.czt-translation').length===2);
}));
test('reused reply nodes can return to previously translated text without losing their cached overlay',()=>withFixture({},async f=>{
  await until(()=>f.w.document.querySelector('.czt-translation'));
  const source=f.w.document.querySelector('.standard-markdown:not(.czt-translation)'),html=source.innerHTML;
  source.innerHTML='<p>New response.</p>';
  await until(()=>source.nextElementSibling?.textContent.includes('新的回复'));
  const before=f.calls.length;source.innerHTML=html;
  await until(()=>source.nextElementSibling?.textContent.includes('你好，世界'));
  assert.equal(f.calls.length,before);
}));
