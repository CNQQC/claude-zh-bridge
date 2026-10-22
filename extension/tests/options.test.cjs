const {JSDOM}=require('jsdom');
const fs=require('node:fs'),path=require('node:path');
const test=require('node:test'),assert=require('node:assert/strict');
const base=path.resolve(__dirname,'..');
const pause=()=>new Promise(resolve=>setTimeout(resolve,15));
async function fixture(fn){
  const dom=new JSDOM(fs.readFileSync(path.join(base,'options.html'),'utf8'),{url:'https://extension.test/options.html',runScripts:'outside-only'});
  const calls=[];
  dom.window.chrome={storage:{local:{get:async()=>({}),set:async value=>{calls.push({storage:value});}}},runtime:{sendMessage:async message=>{
    calls.push(message);
    if(message.type==='CZT_TRANSLATE')return{ok:true,translations:['Example translation'],metadata:{requestedModel:'deepseek-flash',returnedModel:'deepseek-flash',reasoningTokens:null}};
    return{ok:true,configured:false};
  }}};
  dom.window.eval(fs.readFileSync(path.join(base,'options.js'),'utf8'));
  try{await pause();await fn(dom.window,calls);}finally{dom.window.close();}
}
test('options clears password after submit and never displays the key',()=>fixture(async(w,calls)=>{
  const key='sk-fixture-password-123456789';
  w.document.querySelector('#key').value=key;
  w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await pause();
  assert.equal(w.document.querySelector('#key').value,'');
  assert(!w.document.body.textContent.includes(key));
  assert.equal(calls.find(item=>item.type==='CZT_CONFIG_SET').apiKey,key);
}));
test('settings test reports returned model and unknown reasoning counts honestly',()=>fixture(async(w,calls)=>{
  w.document.querySelector('#test').click(); await pause();
  const result=w.document.querySelector('#result');
  assert.equal(result.hidden,false);assert.match(result.textContent,/deepseek-flash/);assert.match(result.textContent,/接口未提供/);
  assert.equal(calls.filter(item=>item.type==='CZT_TRANSLATE').length,2);
}));
test('clear action deletes configured session state through the background',()=>fixture(async(w,calls)=>{
  w.document.querySelector('#clear').click();await pause();
  assert(calls.some(item=>item.type==='CZT_CONFIG_CLEAR'));assert.match(w.document.querySelector('#status').textContent,/已清除/);
}));

test('preferences and retry live in extension settings and signal open chat tabs',()=>fixture(async(w,calls)=>{
  const input=w.document.querySelector('#input');input.checked=false;input.dispatchEvent(new w.Event('change',{bubbles:true}));await pause();
  assert(calls.some(item=>item.storage?.cztSettings?.input===false));
  w.document.querySelector('#retry').click();await pause();
  assert(calls.some(item=>item.type==='CZT_RETRY_FAILED'));assert(calls.some(item=>typeof item.storage?.cztRefreshAt==='number'));
}));
test('public settings require a user-supplied key and expose no built-in-key control',()=>fixture(async(w,calls)=>{
  assert.equal(w.document.querySelector('#default'),null);
  assert.match(w.document.querySelector('#status').textContent,/请填写自己的/);
  assert(!calls.some(item=>item.type==='CZT_CONFIG_DEFAULT'));
}));
