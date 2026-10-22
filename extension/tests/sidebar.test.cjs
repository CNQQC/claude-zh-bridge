const {JSDOM}=require('jsdom');
const fs=require('node:fs'),path=require('node:path');
const test=require('node:test'),assert=require('node:assert/strict');
const {createBackground}=require('./background-harness.cjs');
const base=path.resolve(__dirname,'..');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<180;i++){if(check())return;await pause(10);}throw new Error('Sidebar condition timed out');}
const dictionary={"Selecting master's programs for US finance careers":'面向美国金融职业的硕士项目选择','AI construction phase asset comparison':'AI 建设阶段资产对比','New chat title':'新的会话标题','Updated session title':'更新后的会话标题','Initial greeting':'初次问候'};
const row=(source,id='one')=>`<div data-row-key="chat:${id}"><a href="/chat/${id}" data-row-main-button><span class="df-leading-slot"><svg><title>Idle</title></svg></span><span data-row-label class="flex-1 min-w-0"><span class="truncate">${source}</span></span></a><button aria-label="More options">…</button></div>`;
async function fixture(options={}){
 const dom=new JSDOM(`<!doctype html><body><aside aria-label="Sidebar" class="dframe-sidebar"><div data-testid="sidebar"><a href="/new">New</a><a href="/projects">Projects</a><div data-testid="sidebar-recents">${options.rows||row("Selecting master's programs for US finance careers")+row('AI construction phase asset comparison','two')}</div></div></aside><main><a href="/chat/unrelated">An unrelated link in a message</a><div class="ProseMirror" role="textbox" contenteditable="true"></div></main></body>`,{url:options.url||'https://claude.ai/chat/one',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,calls=[],messages=[],listeners=[],localStore=options.localStore||{}, now=Date.now;
 w.Date.now=()=>now()*100;
 w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden],[inert]')?[]:[{width:100,height:30}];};
 const timeout=w.setTimeout.bind(w),interval=w.setInterval.bind(w);
 w.setTimeout=(fn,ms)=>timeout(fn,Math.min(ms,10));w.setInterval=(fn,ms)=>interval(fn,Math.min(ms,20));
 const worker=options.worker||createBackground({localStore,initialKey:options.noKey?undefined:'sk-fixture-sidebar-only-key',fetch:async(url,request)=>{
  assert.equal(url,'https://api.deepseek.com/chat/completions');
  const body=JSON.parse(request.body),texts=JSON.parse(body.messages[1].content).texts;calls.push(texts);
  assert.equal(body.thinking.type,'disabled');
  if(options.delay)await pause(options.delay);
  if(options.fail)return{ok:false,status:429};
  return{ok:true,status:200,json:async()=>({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(text=>dictionary[text]||'中文：'+text)})}}]})};
 }});
 w.chrome={storage:{onChanged:{addListener:fn=>listeners.push(fn)},local:{get:async()=>({cztSettings:options.settings||{}})}},runtime:{sendMessage:async message=>{messages.push(message);return worker.send(message,w.location.href);}}};
 for(const file of ['scope.js','translator.js','sidebar.js','content.js'])w.eval(fs.readFileSync(path.join(base,file),'utf8'));
 const label=id=>w.document.querySelector(`a[href="/chat/${id}"] [data-row-label]`);
 return{w,dom,calls,messages,localStore,worker,label,settings:next=>listeners.forEach(fn=>fn({cztSettings:{newValue:next}},'local'))};
}
async function run(options,fn){const f=await fixture(options);try{await fn(f);}finally{f.dom.window.close();}}

test('real sidebar structure translates titles in one batch without changing links, icons or layout',()=>run({},async f=>{
 const link=f.label('one').closest('a'),html=f.w.document.querySelector('aside').innerHTML,icons=f.w.document.querySelectorAll('svg').length;
 await until(()=>f.label('one').textContent===dictionary["Selecting master's programs for US finance careers"]&&f.label('two').textContent===dictionary['AI construction phase asset comparison']);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].length,2);
 assert.equal(link.getAttribute('href'),'/chat/one');assert.equal(f.w.document.querySelectorAll('svg').length,icons);
 assert.equal(f.w.document.querySelector('a[href="/new"]').textContent,'New');assert.equal(f.w.document.querySelector('a[href="/projects"]').textContent,'Projects');
 assert.equal(f.w.document.querySelector('main a').textContent,'An unrelated link in a message');
 assert.equal(f.w.document.querySelector('aside').querySelectorAll('a').length,4);assert.equal(f.w.document.querySelector('aside').querySelectorAll('button').length,2);
 let clicked=0;link.addEventListener('click',e=>{e.preventDefault();clicked++;});link.click();assert.equal(clicked,1);
 f.settings({output:false});await until(()=>link.textContent.includes("Selecting master's"));assert.equal(f.w.document.querySelector('aside').innerHTML,html);
}));
test('reload restores all title snapshots with no Key and zero API calls',async()=>{
 const localStore={};await run({localStore},async f=>{await until(()=>f.label('two').textContent===dictionary['AI construction phase asset comparison']);assert.equal(f.calls.length,1);});
 await run({localStore,noKey:true},async f=>{await until(()=>f.label('two').textContent===dictionary['AI construction phase asset comparison']);assert.equal(f.calls.length,0);assert(!f.messages.some(m=>m.type==='CZT_TRANSLATE'));});
});
test('cached titles still restore alongside uncached titles without a Key',async()=>{
 const localStore={};await run({localStore,rows:row('Initial greeting')},async f=>{await until(()=>f.label('one').textContent==='初次问候');});
 await run({localStore,noKey:true,rows:row('Initial greeting')+row('New chat title','new')},async f=>{await until(()=>f.label('one').textContent==='初次问候');await pause(80);assert.equal(f.label('new').textContent,'New chat title');assert.equal(f.calls.length,0);});
});
test('SPA switch, recreated labels and renamed sessions reuse cache and detect new text',()=>run({},async f=>{
 await until(()=>f.label('one').textContent===dictionary["Selecting master's programs for US finance careers"]);
 const before=f.calls.length;f.w.history.pushState({},'','/chat/two');f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));
 await until(()=>f.label('one').textContent===dictionary["Selecting master's programs for US finance careers"]);assert.equal(f.calls.length,before);
 f.label('one').innerHTML='<span>Updated session title</span>';
 await until(()=>f.label('one').textContent==='更新后的会话标题');assert.equal(f.calls.length,before+1);
 const link=f.label('one').closest('a');link.outerHTML=link.outerHTML.replace('更新后的会话标题','Updated session title');
 await until(()=>f.label('one').textContent==='更新后的会话标题');assert.equal(f.calls.length,before+1);
}));
test('new sidebar rows translate automatically and repeated scans never resubmit',()=>run({},async f=>{
 await until(()=>f.label('two').textContent===dictionary['AI construction phase asset comparison']);const before=f.calls.length;
 f.w.document.querySelector('[data-testid="sidebar-recents"]').insertAdjacentHTML('beforeend',row('New chat title','new'));
 await until(()=>f.label('new').textContent==='新的会话标题');await pause(100);assert.equal(f.calls.length,before+1);
}));
test('mixed Chinese titles and hidden rows are untouched',()=>run({rows:row('已存在的中文会话')+`<div hidden>${row('Initial greeting','hidden')}</div>`},async f=>{
 await pause(100);assert.equal(f.label('one').textContent,'已存在的中文会话');assert.equal(f.label('hidden').textContent,'Initial greeting');assert.equal(f.calls.length,0);
}));
for(const url of ['/settings','/projects','/recents','/share/one'])test(`sidebar is inactive on ${url}`,()=>run({url:'https://claude.ai'+url},async f=>{
 await pause(100);assert.equal(f.label('one').textContent,"Selecting master's programs for US finance careers");assert.equal(f.messages.length,0);
}));
test('leaving chat while a title request is pending never updates a non-chat page',()=>run({delay:100},async f=>{
 await until(()=>f.calls.length>0);f.w.history.pushState({},'','/settings');f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));
 await pause(150);assert.equal(f.label('one').textContent,"Selecting master's programs for US finance careers");
 assert.equal(f.w.document.querySelector('[data-czt-owned]'),null);
}));
test('output preference restores English and re-enabling reuses successful cache',()=>run({},async f=>{
 await until(()=>f.label('two').textContent===dictionary['AI construction phase asset comparison']);const before=f.calls.length;
 f.settings({output:false});assert.equal(f.label('two').textContent,'AI construction phase asset comparison');
 f.settings({output:true});await until(()=>f.label('two').textContent===dictionary['AI construction phase asset comparison']);assert.equal(f.calls.length,before);
}));
test('rate-limit errors preserve originals and do not retry automatically',()=>run({fail:true},async f=>{
 await until(()=>f.calls.length===1);await pause(160);assert.equal(f.calls.length,1);assert.equal(f.label('one').textContent,"Selecting master's programs for US finance careers");
}));
test('same-origin checks reject lookalike links and message content',()=>run({rows:row('Initial greeting')+'<a href="https://evil.example/chat/a"><span data-row-label>Do not translate</span></a><a href="/chat/a/extra"><span data-row-label>Not a conversation link</span></a>'},async f=>{
 await until(()=>f.label('one').textContent==='初次问候');assert.deepEqual(f.calls.flat(),['Initial greeting']);
}));
