const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {JSDOM}=require('jsdom');
const {createBackend}=require('../backend.cjs');
const {createStorage}=require('../storage.cjs');
const base=path.resolve(__dirname,'..');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<250;i++){if(fn())return;await pause(10);}throw new Error('Desktop condition timed out');}
async function fixture(fn){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'czt-desktop-test-'));await fsp.mkdir(path.join(root,'extension'));
 for(const file of ['scope.js','cache.js','background.js','options.html'])await fsp.copyFile(path.join(base,'extension',file),path.join(root,'extension',file));
 await fsp.writeFile(path.join(root,'extension/private-config.js'),"self.CztPrivateConfig={apiKey:'sk-fixture-desktop-private-key'};");
 const requests=[],cacheFile=path.join(root,'data/cache.json');let opens=0;
 const backend=createBackend({directory:root,cacheFile,openOptions:async()=>{opens++;},fetcher:async(url,options)=>{
  requests.push(url);
  const texts=JSON.parse(JSON.parse(options.body).messages[1].content).texts;
  return{ok:true,status:200,json:async()=>({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(text=>text==='你好'?'Hello':text==='Desktop session title'?'桌面会话标题':'中文：'+text)})}}]})};
 }});
 try{await fn({root,requests,backend,cacheFile,get opens(){return opens;}});}finally{await fsp.rm(root,{recursive:true,force:true});}
}
test('desktop backend isolates settings and credentials from chat frames and persists paid results',()=>fixture(async f=>{
 const chat='https://claude.ai/chat/test',job={type:'CZT_TRANSLATE',direction:'zh:en',texts:['你好']};
 assert.equal((await f.backend.send({type:'CZT_STATUS'},chat)).configured,true);
 assert(!(JSON.stringify(await f.backend.send({type:'CZT_STATUS'},chat))).includes('sk-fixture'));
 assert.equal((await f.backend.send({type:'CZT_CONFIG_CLEAR'},chat)).code,'FORBIDDEN');
 assert.equal((await f.backend.send({type:'CZT_LOCAL_SET',values:{cztSettings:{input:false}}},chat)).code,'FORBIDDEN');
 assert.equal((await f.backend.send(job,'https://claude.ai/settings')).code,'FORBIDDEN');
 assert.equal((await f.backend.send(job,'https://claude.ai.evil.test/chat/a')).code,'FORBIDDEN');
 assert((await f.backend.send(job,chat)).ok);assert((await f.backend.send(job,chat)).ok);assert.equal(f.requests.length,1);
 const restarted=createBackend({directory:f.root,cacheFile:f.cacheFile,fetcher:async()=>{throw new Error('Cache miss');}});
 assert((await restarted.send(job,chat)).ok);assert(!(await fsp.readFile(f.cacheFile,'utf8')).includes('sk-fixture'));
}));
test('desktop settings can toggle behavior but cannot overwrite arbitrary cache entries',()=>fixture(async f=>{
 assert((await f.backend.send({type:'CZT_LOCAL_SET',values:{cztSettings:{input:true,output:false},cztRefreshAt:123}},f.backend.settingsURL)).ok);
 assert.equal((await f.backend.send({type:'CZT_LOCAL_GET'},'https://claude.ai/new')).values.cztSettings.output,false);
 assert.equal((await f.backend.send({type:'CZT_LOCAL_SET',values:{privateKey:'x'}},f.backend.settingsURL)).code,'BAD_INPUT');
}));
test('corrupt desktop cache fails closed instead of clearing paid results',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'czt-store-test-'));const file=path.join(root,'cache.json');
 try{await fsp.writeFile(file,'invalid');const storage=createStorage(file);await assert.rejects(storage.local.get(null),/refusing to reset/);assert.equal(await fsp.readFile(file,'utf8'),'invalid');}finally{await fsp.rm(root,{recursive:true});}
});
test('atomic desktop storage serializes concurrent writes and keeps private file permissions',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'czt-store-test-'));const file=path.join(root,'cache.json');
 try{const s=createStorage(file);await Promise.all([s.local.set({a:1}),s.local.set({b:2})]);assert.deepEqual(await s.local.get(null),{a:1,b:2});assert.equal((await fsp.stat(file)).mode&0o777,0o600);}finally{await fsp.rm(root,{recursive:true});}
});
test('isolated desktop preload translates native sidebar buttons and cancels settings-page injection',()=>fixture(async f=>{
 const dom=new JSDOM('<!doctype html><aside aria-label="Sidebar"><div data-row-key="chat:test"><button data-row-main-button><span class="df-leading-slot"><svg><title>Idle</title></svg></span><span data-row-label>Desktop session title</span></button><button>More options</button></div></aside><main><div class="ProseMirror" role="textbox" contenteditable="true"></div></main>',{url:'https://claude.ai/new',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,now=Date.now;w.Date.now=()=>now()*100;w.HTMLElement.prototype.getClientRects=()=>[{}];
 const interval=w.setInterval.bind(w);w.setInterval=(fn)=>interval(fn,20);
 w.require=()=>({ipcRenderer:{invoke:(_channel,message)=>f.backend.send(message,w.location.href),on:()=>{}}});
 try{w.eval(fs.readFileSync(path.join(base,'preload.cjs'),'utf8'));await until(()=>w.document.querySelector('[data-row-label]').textContent==='桌面会话标题');assert.equal(w.document.querySelectorAll('aside button').length,2);assert.equal(w.chrome,undefined);assert.equal(w.ClaudeZhTranslator.ready,true);w.history.pushState({},'','/settings');w.dispatchEvent(new w.PopStateEvent('popstate'));await until(()=>w.document.querySelector('[data-row-label]').textContent==='Desktop session title');}finally{w.close();}
}));
test('Desktop Code native session titles translate through the same private backend',()=>fixture(async f=>{
 const dom=new JSDOM('<!doctype html><aside aria-label="Sidebar"><div data-row-key="code-session:test"><button data-row-main-button><span data-row-label>Desktop session title</span></button><button>More options</button></div><button>Projects</button></aside><main><div class="ProseMirror" role="textbox" contenteditable="true"></div></main>',{url:'https://claude.ai/epitaxy',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,now=Date.now;w.Date.now=()=>now()*100;w.HTMLElement.prototype.getClientRects=()=>[{}];
 const interval=w.setInterval.bind(w);w.setInterval=fn=>interval(fn,20);
 w.require=()=>({ipcRenderer:{invoke:(_channel,message)=>f.backend.send(message,w.location.href),on:()=>{}}});
 try{w.eval(fs.readFileSync(path.join(base,'preload.cjs'),'utf8'));await until(()=>w.document.querySelector('[data-row-label]').textContent==='桌面会话标题');assert.equal(w.document.querySelectorAll('aside button').length,3);assert(!w.document.querySelector('aside>button').hasAttribute('data-czt-owned'));assert.equal(f.requests.length,1);}finally{w.close();}
}));
