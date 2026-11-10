// Actual Electron/preload and independent browser views, disposable state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),source=path.resolve(process.env.GITTYGO_TEST_SOURCE||path.join(import.meta.dirname,'..'));
const {createWorkspaceController}=require(path.join(source,'src/workspace-controller.cjs'));
const {default:puppeteer}=await import(process.env.PUPPETEER_MODULE||(() => { throw new Error('Set PUPPETEER_MODULE to the absolute Puppeteer ESM module path.'); })());

test('shared proposals reach actual native preload and multiple web views without stealing drafts/focus', {timeout:90000},async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'gittygo-shared-browser-')),repo=path.join(home,'repo');await fs.mkdir(repo);
 const old=process.env.GITTYGO_STATE_DIR;process.env.GITTYGO_STATE_DIR=path.join(home,'state');
 const env={PATH:process.env.PATH,HOME:home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GITTYGO_STATE_DIR:process.env.GITTYGO_STATE_DIR,NODE_PATH:process.env.NODE_PATH};
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{env,encoding:'utf8'}).trim();
 const cli=(message,action='set')=>JSON.parse(execFileSync(process.execPath,[path.join(source,'bin/gittygo.cjs'),'commit-message',action,'--repo',repo,...(action==='set'?['--message',message]:[]),'--json'],{env,encoding:'utf8'}));
 let controller,server,browser,native,child,nativeErrors='';
 try {
  git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');await fs.writeFile(path.join(repo,'file.txt'),'seed');git('add','.');git('commit','-qm','seed');await fs.writeFile(path.join(repo,'file.txt'),'dirty');
  controller=await createWorkspaceController(repo);
  server=http.createServer(async(req,res)=>{try{
   if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const call=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await controller.dispatch(call.method,call.args)));return;}
   const file=new URL(req.url,'http://fixture').pathname.split('/').pop()||'index.html';if(!['index.html','renderer.js','browser-adapter.js','styles.css'].includes(file)){res.writeHead(404);res.end();return;}
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(path.join(source,'src/renderer',file)));
  }catch(error){res.writeHead(500);res.end(error.message);}});server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/w/fixture/`;
  browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:path.join(home,'browser'),env:{...process.env,HOME:home}});
  const web=await browser.newPage(),errors=[];web.on('pageerror',e=>errors.push(e.message));await web.goto(url);await web.waitForSelector('.file-row');await web.type('#commit-message','Human draft');
  await web.$eval('#commit-message',e=>{e.focus();e.setSelectionRange(2,7,'backward');});
  const portProbe=net.createServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  const bootstrap=path.join(home,'bootstrap.cjs');await fs.writeFile(bootstrap,`const {app}=require('electron');app.on('browser-window-created',(_e,w)=>w.hide());require(${JSON.stringify(process.env.GITTYGO_NATIVE_MAIN||path.join(source,'src/main.cjs'))});`);
  child=spawn(process.env.GITTYGO_ELECTRON||require('electron'),[bootstrap,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${home}/native`,'--',repo],{env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',data=>{nativeErrors=(nativeErrors+data).slice(-6000);});
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(`Native fixture exited ${child.exitCode}`);try{native=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`});break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  assert.ok(native,nativeErrors);let desktop;
  for(let i=0;i<100;i++){desktop=(await native.pages()).find(p=>p.url().includes('/renderer/index.html'));if(desktop)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(desktop);desktop.on('pageerror',e=>errors.push(e.message));await desktop.waitForSelector('.file-row');assert.equal(await desktop.evaluate(()=>document.documentElement.classList.contains('browser-host')),false);
  cli('Shared suggestion');await desktop.waitForFunction(()=>document.querySelector('#commit-message').value==='Shared suggestion');await web.waitForSelector('#commit-proposal:not([hidden])');
  assert.deepEqual(await web.$eval('#commit-message',e=>({value:e.value,start:e.selectionStart,end:e.selectionEnd,direction:e.selectionDirection,focus:document.activeElement===e})),{value:'Human draft',start:2,end:7,direction:'backward',focus:true});
  const second=await browser.newPage();second.on('pageerror',e=>errors.push(e.message));await second.goto(url);await second.waitForFunction(()=>document.querySelector('#commit-message').value==='Shared suggestion');
  await web.bringToFront();
  const text='<script>window.pwned=1</script>\nRevised proposal';cli(text);await web.waitForFunction(text=>document.querySelector('#commit-proposal-text').textContent===text,{},text);await desktop.waitForSelector('#commit-proposal:not([hidden])');
  assert.equal(await desktop.$eval('#commit-message',e=>e.value),'Shared suggestion','even previous auto-filled text is not silently overwritten');
  await web.click('#commit-proposal summary');assert.equal(await web.$('#commit-proposal-text script'),null);assert.equal(await web.evaluate(()=>window.pwned),undefined);
  web.once('dialog',dialog=>dialog.dismiss());await web.click('#use-commit-proposal');assert.equal(await web.$eval('#commit-message',e=>e.value),'Human draft');
  web.once('dialog',dialog=>dialog.accept());await web.click('#use-commit-proposal');assert.equal(await web.$eval('#commit-message',e=>e.value),text);
  cli('','clear');await desktop.waitForSelector('#commit-proposal[hidden]');assert.equal(await desktop.$eval('#commit-message',e=>e.value),'Shared suggestion','clearing a proposal does not clear a local draft');
  cli('Before commit');git('commit','--allow-empty','-qm','new head');const after=await browser.newPage();await after.goto(url);await after.waitForSelector('.file-row');assert.equal(await after.$eval('#commit-message',e=>e.value),'','old HEAD proposal must not reappear in a new window');
  assert.deepEqual(errors,[]);console.log('Actual Electron + multiple independent web views: shared scope, no consume race, drafts/focus/selection preserved, explicit replacement/cancel, inert preview, clear and HEAD invalidation PASS');
 } finally {
  native?.disconnect();if(child&&child.exitCode===null&&!child.signalCode){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await controller?.close();if(old===undefined)delete process.env.GITTYGO_STATE_DIR;else process.env.GITTYGO_STATE_DIR=old;await fs.rm(home,{recursive:true,force:true});
 }
});
