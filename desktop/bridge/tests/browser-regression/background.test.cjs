const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackground } = require('./background-harness.cjs');
const KEY = 'sk-fixture-not-a-real-key-123456789';
const sender = 'chrome-extension://test-extension/options.html';
const job = { type:'CZT_TRANSLATE', direction:'zh:en', texts:['你好'] };
const answer = overrides => ({ model:'deepseek-v4.1-flash', choices:[{finish_reason:'stop',message:{content:'{"translations":["Hello"]}',reasoning_content:null}}], usage:{completion_tokens_details:{reasoning_tokens:0}}, ...overrides });
const response = (data, status = 200) => ({ok:status===200,status,json:async()=>data});

test('requests official V4.1 Flash alias with thinking disabled; checks returned metadata', async () => {
  let captured;
  const worker=createBackground({initialKey:KEY,fetch:async(url,options)=>{captured={url,options};return response(answer({id:'fixture-request-id'}));}});
  const result=await worker.send(job);
  assert(result.ok); assert.equal(result.translations[0],'Hello');
  assert.equal(captured.url,'https://api.deepseek.com/chat/completions');
  const body=JSON.parse(captured.options.body);
  assert.equal(body.model,'deepseek-flash'); assert.deepEqual(body.thinking,{type:'disabled'});
  assert.equal(captured.options.headers.Authorization,`Bearer ${KEY}`);
  assert.equal(captured.options.redirect,'error'); assert.equal(result.metadata.reasoningTokens,0);
  assert.equal(result.metadata.returnedModel,'deepseek-v4.1-flash');
  assert.equal(result.metadata.requestId,'fixture-request-id');assert.equal(result.metadata.batchSize,1);
});
test('key is in trusted session storage and is never returned to content scripts', async () => {
  const worker=createBackground({initialKey:KEY});
  const result=await worker.send({type:'CZT_STATUS'});
  assert(result.configured); assert.equal(worker.accessLevel,'TRUSTED_CONTEXTS');
  assert(!JSON.stringify(result).includes(KEY));
  assert.equal((await worker.send({type:'CZT_CONFIG_SET',apiKey:KEY})).code,'FORBIDDEN');
});
test('settings verifies official model metadata before storing the supplied key', async () => {
  const worker=createBackground({fetch:async()=>response({data:[{id:'deepseek-flash',name:'DeepSeek-V4.1-Flash'}]})});
  assert((await worker.send({type:'CZT_CONFIG_SET',apiKey:KEY},sender)).ok);
  assert.equal(worker.stored.cztDeepSeekKey,KEY);
  await worker.send({type:'CZT_CONFIG_CLEAR'},sender);
  assert(!(await worker.send({type:'CZT_STATUS'})).configured);
});
test('model mismatch during configuration does not save a key', async () => {
  const worker=createBackground({fetch:async()=>response({data:[{id:'deepseek-flash',name:'Other model'}]})});
  assert.equal((await worker.send({type:'CZT_CONFIG_SET',apiKey:KEY},sender)).code,'MODEL_MISMATCH');
  assert.equal(worker.stored.cztDeepSeekKey,undefined);
});
test('missing key, wrong sender and malformed input fail before any network call', async () => {
  let calls=0; const worker=createBackground({fetch:async()=>{calls++;return response(answer());}});
  assert.equal((await worker.send(job)).code,'NO_KEY');
  assert.equal((await worker.send(job,'https://example.com')).code,'FORBIDDEN');
  assert.equal((await worker.send({...job,direction:'xx:yy'})).code,'BAD_INPUT'); assert.equal(calls,0);
});
for(const status of [401,402,429]) test(`HTTP ${status} fails explicitly without fallback`,async()=>{
  let calls=0; const worker=createBackground({initialKey:KEY,fetch:async()=>{calls++;return response({},status);}});
  const result=await worker.send(job); assert.equal(result.code,`HTTP_${status}`); assert.equal(calls,1);
});
test('returned model, thinking content and nonzero reasoning tokens are enforced', async () => {
  for(const [data,code] of [
    [answer({model:'another-model'}),'MODEL_MISMATCH'],
    [answer({choices:[{finish_reason:'stop',message:{content:'{}',reasoning_content:'thinking'}}]}),'THINKING_ENABLED'],
    [answer({usage:{completion_tokens_details:{reasoning_tokens:10}}}),'THINKING_ENABLED']
  ]) {
    const worker=createBackground({initialKey:KEY,fetch:async()=>response(data)});
    assert.equal((await worker.send(job)).code,code);
  }
});
test('malformed, incomplete or missing translations are rejected',async()=>{
  for(const [choice,code] of [
    [{finish_reason:'length',message:{content:'{}'}},'INCOMPLETE'],
    [{finish_reason:'stop',message:{content:'not json'}},'INVALID_OUTPUT'],
    [{finish_reason:'stop',message:{content:'{"translations":[]}'}},'INVALID_OUTPUT']
  ]) {
    const worker=createBackground({initialKey:KEY,fetch:async()=>response(answer({choices:[choice]}))});
    assert.equal((await worker.send(job)).code,code);
  }
});
test('70 short text nodes share one LLM request regardless of block count',async()=>{
  let calls=0;
  const worker=createBackground({initialKey:KEY,fetch:async(_,options)=>{
    calls++; const texts=JSON.parse(JSON.parse(options.body).messages[1].content).texts;
    return response(answer({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(()=> 'Hello')})}}]}));
  }});
  const result=await worker.send({...job,texts:Array.from({length:70},(_,i)=>'你好 '+i)});
  assert(result.ok); assert.equal(result.translations.length,70); assert.equal(calls,1);
});
test('oversized translations split only at the output budget and preserve result order',async()=>{
  const calls=[];
  const worker=createBackground({initialKey:KEY,fetch:async(_,options)=>{
    const texts=JSON.parse(JSON.parse(options.body).messages[1].content).texts;calls.push(texts);
    return response(answer({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:texts.map(text=>'译文'+text[0])})}}]}));
  }});
  const result=await worker.send({...job,texts:['a'.repeat(3000),'b'.repeat(3000),'c'.repeat(3000)]});
  assert(result.ok);assert.deepEqual(calls.map(items=>items.length),[2,1]);
  assert.deepEqual([...result.translations],['译文a','译文b','译文c']);
});
test('network timeout is surfaced without retry or provider fallback',async()=>{
  const worker=createBackground({initialKey:KEY,timers:{setTimeout:fn=>setTimeout(fn,5)},fetch:async(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
  assert.equal((await worker.send(job)).code,'TIMEOUT');
});

test('private built-in key works without setup or session persistence and is never exposed in status',async()=>{
  let authorization;
  const worker=createBackground({builtInKey:KEY,fetch:async(_,options)=>{authorization=options.headers.Authorization;return response(answer());}});
  const status=await worker.send({type:'CZT_STATUS'});
  assert.equal(status.configured,true);assert.equal(status.builtIn,true);
  assert(!JSON.stringify(status).includes(KEY));assert.equal(worker.stored.cztDeepSeekKey,undefined);
  assert((await worker.send(job)).ok);assert.equal(authorization,`Bearer ${KEY}`);
});
test('built-in key can be disabled for this session and restored only from extension settings',async()=>{
  const worker=createBackground({builtInKey:KEY,fetch:async()=>response({data:[{id:'deepseek-flash',name:'DeepSeek-V4.1-Flash'}]})});
  assert((await worker.send({type:'CZT_CONFIG_CLEAR'},sender)).ok);
  assert.equal((await worker.send({type:'CZT_STATUS'})).configured,false);
  assert.equal((await worker.send(job)).code,'NO_KEY');
  assert.equal((await worker.send({type:'CZT_CONFIG_DEFAULT'})).code,'FORBIDDEN');
  assert((await worker.send({type:'CZT_CONFIG_DEFAULT'},sender)).ok);
  assert.equal((await worker.send({type:'CZT_STATUS'})).configured,true);
});
test('browser restart automatically restores the built-in key and reuses successful cached translations',async()=>{
  const localStore={};let calls=0;
  const options={localStore,builtInKey:KEY,fetch:async()=>{calls++;return response(answer());}};
  const first=createBackground(options);assert((await first.send(job)).ok);
  const restarted=createBackground(options);assert.equal((await restarted.send({type:'CZT_STATUS'})).configured,true);
  assert((await restarted.send(job)).ok);assert.equal(calls,1);
});
