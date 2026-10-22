'use strict';
const {app,session,ipcMain,BrowserWindow,webContents,shell}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {createBackend}=require('./backend.cjs');
const {readConfig}=require('./config.cjs');
let backend,optionsWindow;
function openOptions(){
  const configured=readConfig(path.join(app.getPath('userData'),'czt-desktop','config.json'));
  if(configured?.patcherPath&&configured.patcherPath.endsWith('.app')&&fs.existsSync(path.join(configured.patcherPath,'Contents/MacOS/ClaudeZhPatcher'))){shell.openPath(configured.patcherPath);return;}
  if(optionsWindow&&!optionsWindow.isDestroyed()){optionsWindow.focus();return;}
  optionsWindow=new BrowserWindow({width:650,height:850,title:'Claude Desktop 中文桥设置',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  optionsWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  optionsWindow.webContents.on('will-navigate',(event,url)=>{if(url!==backend.settingsURL)event.preventDefault();});
  optionsWindow.loadURL(backend.settingsURL);
}
function getBackend(){
  if(!backend)backend=createBackend({cacheFile:path.join(app.getPath('userData'),'czt-desktop','cache.json'),configFile:path.join(app.getPath('userData'),'czt-desktop','config.json'),openOptions,changed:changes=>{
    for(const wc of webContents.getAllWebContents()){
      try{for(const frame of wc.mainFrame.framesInSubtree)if(backend.allowed(frame.url))frame.send('czt-desktop:settings',changes);}catch{}
    }
  }});
  return backend;
}
ipcMain.handle('czt-desktop:rpc',async(event,message)=>{
  try{return await getBackend().send(message,event.senderFrame?.url||'');}
  catch{return{ok:false,code:'DESKTOP_BACKEND',error:'桌面翻译缓存或后台不可用，已保留原文。'};}
});
const registered=new WeakSet();
function attach(ses){
  if(registered.has(ses))return;
  if(typeof ses.registerPreloadScript!=='function')throw new Error('Claude Electron version does not support isolated preload registration.');
  ses.registerPreloadScript({type:'frame',id:'czt-desktop-zh',filePath:path.join(__dirname,'preload.cjs')});registered.add(ses);
}
app.on('session-created',attach);
app.whenReady().then(()=>attach(session.defaultSession));
app.whenReady().then(()=>{
  const file=path.join(app.getPath('userData'),'czt-desktop','config.json');
  fs.watchFile(file,{persistent:false,interval:900},(current,previous)=>{
    if(current.mtimeMs!==previous.mtimeMs&&backend)try{backend.refreshConfig();}catch{/* Invalid config fails closed on the next request. */}
  });
  app.once('will-quit',()=>fs.unwatchFile(file));
});
