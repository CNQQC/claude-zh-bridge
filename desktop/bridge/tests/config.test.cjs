const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createBackend}=require('../backend.cjs');
const {readConfig}=require('../config.cjs');
async function fixture(run){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'czt-config-'));await fs.mkdir(path.join(root,'extension'));
 for(const file of ['background.js','cache.js','scope.js'])await fs.copyFile(path.join(__dirname,'../extension',file),path.join(root,'extension',file));
 await fs.writeFile(path.join(root,'extension/private-config.js'),"self.CztPrivateConfig={apiKey:''};");
 const file=path.join(root,'config.json');let config={provider:{apiKey:'sk-fixture-config-private-key',baseURL:'https://api.deepseek.com',model:'deepseek-flash'},features:{input:true,output:true,titles:true,chat:true,code:true}};
 const save=async()=>fs.writeFile(file,JSON.stringify(config),{mode:0o600});await save();
 try{await run({root,file,config,save});}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('provider config rejects insecure URLs and preserves the existing default cache namespace',()=>fixture(async f=>{
 assert.equal(readConfig(f.file).cacheNamespace,'deepseek-flash|thinking-disabled|translation-json-v1');
 for(const bad of ['http://api.deepseek.com','https://secret@example.com','https://example.com/?key=secret']){
  f.config.provider.baseURL=bad;await f.save();assert.throws(()=>readConfig(f.file));
 }
}));
test('model and endpoint edits separate paid caches, returning to a previous model reuses saved work',()=>fixture(async f=>{
 let calls=0,events=[];
 const backend=createBackend({directory:f.root,configFile:f.file,cacheFile:path.join(f.root,'cache.json'),changed:e=>events.push(e),fetcher:async(url,options)=>{
  const body=JSON.parse(options.body);calls++;assert.equal(body.thinking.type,'disabled');
  assert.equal(options.headers.Authorization,'Bearer sk-fixture-config-private-key');
  return{ok:true,json:async()=>({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:[body.model+' translation']})}}]})};
 }});
 const chat='https://claude.ai/chat/test',job={type:'CZT_TRANSLATE',direction:'zh:en',texts:['你好']};
 assert.equal((await backend.send(job,chat)).translations[0],'deepseek-flash translation');
 f.config.provider.model='translation-custom';f.config.provider.baseURL='https://relay.example/v1';await f.save();
 assert.equal((await backend.send(job,chat)).translations[0],'translation-custom translation');
 const exposed=JSON.stringify(await backend.send({type:'CZT_LOCAL_GET'},chat))+JSON.stringify(events);
 assert(!exposed.includes(f.config.provider.apiKey));assert.equal((await backend.send({type:'CZT_STATUS'},chat)).model,'translation-custom');
 f.config.provider.model='deepseek-flash';f.config.provider.baseURL='https://api.deepseek.com';await f.save();
 assert.equal((await backend.send(job,chat)).translations[0],'deepseek-flash translation');assert.equal(calls,2);
 assert(!await fs.readFile(path.join(f.root,'cache.json'),'utf8').then(s=>s.includes(f.config.provider.apiKey)));
}));
test('in-flight requests keep their original provider when settings change',()=>fixture(async f=>{
 let release,started;const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);let calls=0;
 const backend=createBackend({directory:f.root,configFile:f.file,cacheFile:path.join(f.root,'cache.json'),fetcher:async(url,options)=>{
  const body=JSON.parse(options.body);calls++;if(body.model==='deepseek-flash'){started();await gate;}
  return{ok:true,json:async()=>({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:[body.model]})}}]})};
 }});
 const url='https://claude.ai/chat/test',job={type:'CZT_TRANSLATE',direction:'zh:en',texts:['相同文本']};
 const first=backend.send(job,url);await entered;f.config.provider.model='different-model';await f.save();
 assert.equal((await backend.send(job,url)).translations[0],'different-model');release();assert.equal((await first).translations[0],'deepseek-flash');
 assert.equal((await backend.send(job,url)).translations[0],'different-model');assert.equal(calls,2);
}));
test('queued display batches preserve their provider snapshot before the collection window ends',()=>fixture(async f=>{
 const calls=[];
 const backend=createBackend({directory:f.root,configFile:f.file,cacheFile:path.join(f.root,'cache.json'),fetcher:async(url,options)=>{
  const body=JSON.parse(options.body),texts=JSON.parse(body.messages[1].content).texts;calls.push({url,model:body.model,texts});
  return{ok:true,json:async()=>({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(text=>body.model+':'+text)})}}]})};
 }});
 const url='https://claude.ai/chat/test',job={type:'CZT_TRANSLATE',direction:'en:zh',texts:['Original provider block']};
 const first=backend.send(job,url);await new Promise(resolve=>setTimeout(resolve,25));
 f.config.provider.model='custom-model';f.config.provider.baseURL='https://relay.example/v1';await f.save();
 const second=backend.send({...job,texts:['New provider title']},url);
 const results=await Promise.all([first,second]);assert(results.every(result=>result.ok));
 assert.deepEqual(calls.map(call=>[call.url,call.model]),[['https://api.deepseek.com/chat/completions','deepseek-flash'],['https://relay.example/v1/chat/completions','custom-model']]);
 assert.deepEqual(calls.map(call=>call.texts),[['Original provider block'],['New provider title']]);
}));
