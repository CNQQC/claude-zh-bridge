const test=require('node:test'),assert=require('node:assert/strict');
const {createBackground}=require('./background-harness.cjs');
const KEY='sk-fixture-cache-not-a-real-key';
const job={type:'CZT_TRANSLATE',direction:'en:zh',texts:['First message']};
function api(calls,delay=0){return async(_,options)=>{
  const texts=JSON.parse(JSON.parse(options.body).messages[1].content).texts;calls.push(texts);
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  return{ok:true,status:200,json:async()=>({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(text=>'中文:'+text)})}}]})};
};}
test('completed translations survive worker/browser recreation and work without a Key',async()=>{
  const localStore={},calls=[];
  const first=createBackground({initialKey:KEY,localStore,fetch:api(calls)});
  assert((await first.send(job)).ok);
  const second=createBackground({localStore,fetch:async()=>{throw new Error('Must not call API');}});
  const result=await second.send(job);
  assert(result.ok);assert.equal(result.cache.hits,1);assert.equal(result.cache.requested,0);assert.equal(calls.length,1);
  assert(!JSON.stringify(localStore).includes(KEY));
});
test('two tabs and duplicate texts share one in-flight request',async()=>{
  const calls=[],worker=createBackground({initialKey:KEY,fetch:api(calls,25)});
  const [a,b]=await Promise.all([worker.send({...job,texts:['same','same']}),worker.send({...job,texts:['same']},'https://claude.ai/chat/other')]);
  assert(a.ok&&b.ok);assert.equal(calls.length,1);assert.equal(calls[0].length,1);assert.equal(a.translations.length,2);assert.equal(b.translations[0],a.translations[0]);
});
test('independent blocks and titles coalesce after cache filtering, with stable per-caller order',async()=>{
  const calls=[],localStore={},worker=createBackground({initialKey:KEY,localStore,fetch:api(calls)});
  await worker.send({...job,texts:['Cached paragraph']});calls.length=0;
  const results=await Promise.all([
    worker.send({...job,texts:['Cached paragraph','First block','Shared block']}),
    worker.send({...job,texts:['Second block','Shared block']},'https://claude.ai/chat/other'),
    worker.send({...job,texts:['Session title']})
  ]);
  assert(results.every(result=>result.ok));assert.equal(calls.length,1);
  assert.deepEqual(new Set(calls[0]),new Set(['First block','Shared block','Second block','Session title']));
  assert.deepEqual([...results[1].translations],['中文:Second block','中文:Shared block']);
  const restarted=createBackground({localStore,fetch:api(calls)});
  assert((await restarted.send({...job,texts:['First block','Session title','Second block']})).ok);
  assert.equal(calls.length,1);
});
test('Chinese input bypasses the display collection window and never shares its target language',async()=>{
  const calls=[],worker=createBackground({initialKey:KEY,fetch:api(calls)});
  const display=worker.send(job);
  const input=await worker.send({...job,direction:'zh:en',texts:['你好']});
  assert(input.ok);assert.deepEqual(calls,[['你好']]);
  assert((await display).ok);assert.equal(calls.length,2);
});
test('a failed combined request blocks every charged segment across worker restarts',async()=>{
  const calls=[],localStore={},worker=createBackground({initialKey:KEY,localStore,fetch:async(_,options)=>{
    calls.push(JSON.parse(JSON.parse(options.body).messages[1].content).texts);return{ok:false,status:429};
  }});
  const result=await Promise.all(['Block one','Block two','Title'].map(text=>worker.send({...job,texts:[text]})));
  assert(result.every(item=>item.code==='HTTP_429'));assert.equal(calls.length,1);
  const restarted=createBackground({initialKey:KEY,localStore,fetch:api(calls)});
  assert.equal((await restarted.send({...job,texts:['Block two']})).code,'HTTP_429');assert.equal(calls.length,1);
});
test('a partially cached request sends only the new text to DeepSeek',async()=>{
  const calls=[],worker=createBackground({initialKey:KEY,fetch:api(calls)});
  await worker.send({...job,texts:['old']});
  const result=await worker.send({...job,texts:['old','new','old']});
  assert(result.ok);assert.equal(calls.length,2);assert.deepEqual(calls[1],['new']);assert.equal(result.cache.hits,2);
});
test('cache keys distinguish translation directions and changed source text',async()=>{
  const calls=[],worker=createBackground({initialKey:KEY,fetch:api(calls)});
  await worker.send(job);await worker.send({...job,direction:'zh:en'});await worker.send({...job,texts:['Changed message']});
  assert.equal(calls.length,3);
});
test('input originals and full rendered messages persist without network calls',async()=>{
  const localStore={};let calls=0;
  let worker=createBackground({localStore,fetch:async()=>{calls++;throw new Error('No network');}});
  await worker.send({type:'CZT_ORIGINAL_PUT',english:'Hello\n\nworld',original:'你好，世界'});
  await worker.send({type:'CZT_VIEW_PUT',source:'First message',role:'assistant',view:{html:'<p>第一条消息</p>'}});
  worker=createBackground({localStore});
  assert.equal((await worker.send({type:'CZT_ORIGINAL_GET',english:'Hello world'})).original,'你好，世界');
  assert.equal((await worker.send({type:'CZT_VIEW_GET',source:'First message',role:'assistant'})).view.html,'<p>第一条消息</p>');
  assert.equal(calls,0);
});
test('every original variant is retained and code whitespace remains distinct',async()=>{
  const worker=createBackground();
  await Promise.all(['你好','您好'].map(original=>worker.send({type:'CZT_ORIGINAL_PUT',english:'Hello',original})));
  const entry=Object.values(worker.localStore).find(value=>value.versions);
  assert.equal(entry.versions.length,2);
  await worker.send({type:'CZT_ORIGINAL_PUT',english:'Code `a  b`',original:'原稿'});
  assert.equal((await worker.send({type:'CZT_ORIGINAL_GET',english:'Code `a b`'})).original,null);
});
test('render snapshots preserve differences in code indentation and nonbreaking spaces',async()=>{
  const worker=createBackground();
  await worker.send({type:'CZT_VIEW_PUT',source:'    print(1)\nExplanation',role:'assistant',view:{html:'<div><pre>    print(1)</pre>解释</div>'}});
  assert.equal((await worker.send({type:'CZT_VIEW_GET',source:'print(1)\nExplanation',role:'assistant'})).view,null);
  await worker.send({type:'CZT_VIEW_PUT',source:'a\u00a0b',role:'user',view:{html:'<div>甲</div>'}});
  assert.equal((await worker.send({type:'CZT_VIEW_GET',source:'a b',role:'user'})).view,null);
});
test('unconfirmed paid results are not automatically resubmitted after a restart',async()=>{
  const localStore={},calls=[];
  const first=createBackground({initialKey:KEY,localStore,fetch:api(calls),failWrites:values=>Object.values(values).some(value=>value.state==='done')});
  assert.equal((await first.send(job)).code,'CACHE_STORAGE');assert.equal(calls.length,1);
  const second=createBackground({initialKey:KEY,localStore,fetch:api(calls)});
  assert.equal((await second.send(job)).code,'CACHE_PENDING');assert.equal(calls.length,1);
  await second.send({type:'CZT_RETRY_FAILED'});
  assert((await second.send(job)).ok);assert.equal(calls.length,2);
});
test('a storage failure before the request causes no API charge',async()=>{
  const calls=[],worker=createBackground({initialKey:KEY,fetch:api(calls),failWrites:()=>true});
  assert.equal((await worker.send(job)).code,'CACHE_STORAGE');assert.equal(calls.length,0);
});
test('manual retry removes only failed markers and preserves successful results',async()=>{
  const localStore={},calls=[];let failed=true;
  const fetcher=api(calls);
  const worker=createBackground({initialKey:KEY,localStore,fetch:async(url,options)=>{
    const texts=JSON.parse(JSON.parse(options.body).messages[1].content).texts;
    if(texts[0]==='bad'&&failed){calls.push(texts);return{ok:false,status:429};}
    return fetcher(url,options);
  }});
  await worker.send(job);
  assert.equal((await worker.send({...job,texts:['bad']})).code,'HTTP_429');
  assert.equal((await worker.send({...job,texts:['bad']})).code,'HTTP_429');assert.equal(calls.length,2);
  failed=false;await worker.send({type:'CZT_RETRY_FAILED'});
  assert.equal((await worker.send(job)).cache.hits,1);
  assert((await worker.send({...job,texts:['bad']})).ok);assert.equal(calls.length,3);
});
