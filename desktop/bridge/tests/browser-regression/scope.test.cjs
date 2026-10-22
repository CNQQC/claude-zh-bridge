const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createBackground}=require('./background-harness.cjs');
const surface={};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../extension/scope.js'),'utf8'),{self:surface,URL});
test('only Claude home/new-chat and individual private conversation URLs are accepted',()=>{
  for(const url of ['https://claude.ai/','https://claude.ai/new','https://claude.ai/new/','https://claude.ai/chat/abc-123','https://claude.ai/chat/abc_123/?x=1#message'])assert(surface.CztChatScope.isChatURL(url),url);
  for(const url of ['https://claude.ai/settings','https://claude.ai/settings/profile','https://claude.ai/projects','https://claude.ai/project/abc','https://claude.ai/login','https://claude.ai/recents','https://claude.ai/artifacts','https://claude.ai/share/abc','https://claude.ai/chat','https://claude.ai/chat/abc/settings','https://claude.ai/newer','https://claude.ai/new/nested','https://claude.ai/chat/a%2Fb','https://www.claude.ai/new','http://claude.ai/new','https://claude.ai.evil.example/new','invalid'])assert.equal(surface.CztChatScope.isChatURL(url),false,url);
});
test('background rejects non-chat Claude senders before network or cache mutations',async()=>{
  let calls=0;const worker=createBackground({initialKey:'sk-fixture-scope-key',fetch:async()=>{calls++;throw new Error('Must not call');}});
  for(const url of ['https://claude.ai/settings/profile','https://claude.ai/project/abc','https://claude.ai/login','https://claude.ai/share/abc']){
    for(const message of [{type:'CZT_STATUS'},{type:'CZT_TRANSLATE',direction:'zh:en',texts:['你好']},{type:'CZT_VIEW_PUT',source:'Hello',role:'assistant',view:{html:'<p>你好</p>'}},{type:'CZT_ORIGINAL_PUT',english:'Hello',original:'你好'}])assert.equal((await worker.send(message,url)).code,'FORBIDDEN');
  }
  assert.equal(calls,0);assert.equal(Object.keys(worker.localStore).length,0);
});
test('Desktop Code scope accepts only epitaxy chat routes, excluding tools, settings and lookalikes',()=>{
  for(const url of ['https://claude.ai/epitaxy','https://claude.ai/epitaxy/','https://claude.ai/epitaxy/session-123?view=chat'])assert(surface.CztChatScope.isCodeURL(url),url);
  for(const url of ['https://claude.ai/epitaxy/settings','https://claude.ai/epitaxy/settings/profile','https://claude.ai/epitaxy/projects','https://claude.ai/epitaxyevil','https://claude.ai/code','https://claude.ai/chat/a','https://evil.example/epitaxy'])assert.equal(surface.CztChatScope.isCodeURL(url),false,url);
});
