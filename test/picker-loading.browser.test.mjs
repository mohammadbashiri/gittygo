// Actual renderer/transport, private HTTP/Chrome only. No Git or native owner runtime.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {default:puppeteer}=await import(pathToFileURL(process.env.PUPPETEER_MODULE||(() => { throw new Error('Set PUPPETEER_MODULE to the absolute Puppeteer ESM module path.'); })()));
test('picker prefetch, quiet cold threshold, instant warm lists and safe deferred refresh',async t=>{
 const assets=process.env.GITTYGO_TEST_ROOT?pathToFileURL(process.env.GITTYGO_TEST_ROOT+'/src/renderer/'):new URL('../src/renderer/',import.meta.url);
 const root='/fixture/repo',calls=[],held={worktrees:[],branches:[]},hold=new Set(['worktrees','branches']);let version=1;
 const response=kind=>kind==='worktrees'?[{path:root,branch:'main',valid:true,selected:true,main:true,invoking:true,staged:0,changes:0}]:[{name:'main',current:true},{name:'feature-'+version}];
 const send=(res,result)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result}));};
 const release=kind=>{hold.delete(kind);for(const res of held[kind].splice(0))send(res,response(kind));};
 const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'){
   let data='';for await(const c of req)data+=c;const body=JSON.parse(data);const kind=body.method==='readTarget'?body.args[1]:body.method;calls.push({...body,kind});
   if(kind in held){if(hold.has(kind))held[kind].push(res);else send(res,response(kind));return;}
   send(res,kind==='state'?{repo:root,name:'repo',branch:'main',head:'abc',changes:[],staged:[]}:kind==='reviewState'?{comments:[]}:{});return;
  }
  const name=new URL(req.url,'http://fixture').pathname.split('/').pop()||'index.html';
  if(!['index.html','renderer.js','browser-adapter.js','styles.css'].includes(name)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL(name,assets)));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 t.after(async()=>{for(const kind of Object.keys(held))release(kind);await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.evaluateOnNewDocument(()=>{
  const set=window.setTimeout.bind(window),clear=window.clearTimeout.bind(window),timers=new Map();let clock=0,id=-1;
  window.setTimeout=(fn,ms,...args)=>{if(ms!==300)return set(fn,ms,...args);const key=id--;timers.set(key,{at:clock+ms,fn:()=>fn(...args)});return key;};
  window.clearTimeout=key=>{if(key<0)timers.delete(key);else clear(key);};
  window.advancePicker=ms=>{clock+=ms;for(const [key,timer]of timers)if(timer.at<=clock){timers.delete(key);timer.fn();}};
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/w/fixture/`);await page.waitForFunction(()=>model.repo?.repo==='/fixture/repo');
 await page.waitForFunction(()=>!!(pickerSnapshot('branches',model.repo.repo).pending&&pickerSnapshot('worktrees',model.repo.repo).pending));
 assert.ok(calls.some(c=>c.kind==='branches')&&calls.some(c=>c.kind==='worktrees'),'both lists start before any picker click');
 const loading=()=>page.evaluate(()=>[...document.querySelectorAll('#worktree-popover:not(.hidden),#branch-popover:not(.hidden)')].some(e=>/Loading (folders|branches)/.test(e.textContent)));
 await page.click('#repo-name');await page.evaluate(()=>advancePicker(299));assert.equal(await loading(),false);
 release('worktrees');await page.waitForSelector('#worktree-popover [data-view-worktree]');await page.evaluate(()=>advancePicker(1));assert.equal(await loading(),false,'fast completion cancels indicator');
 await page.keyboard.press('Escape');await page.click('#branch-button');await page.evaluate(()=>advancePicker(299));assert.equal(await loading(),false);
 await page.evaluate(()=>advancePicker(1));assert.equal(await loading(),true,'genuinely slow cold load shows indicator at 300ms');
 await page.keyboard.press('Escape');release('branches');await page.waitForFunction(()=>pickerSnapshot('branches',model.repo.repo).value!==null);
 hold.add('branches');await page.click('#branch-button');await page.waitForSelector('.branch-row');await page.evaluate(()=>advancePicker(1000));assert.equal(await loading(),false,'warm list never shows loading even with refresh held');
 await page.waitForFunction(()=>pickerSnapshot('branches',model.repo.repo).pending!==null);
 await page.$eval('[data-branch="feature-1"]',e=>e.focus());version=2;release('branches');await page.waitForFunction(()=>pickerSnapshot('branches',model.repo.repo).value.some(b=>b.name==='feature-2'));
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.branch),'feature-1','background result does not replace focused rows');
 await page.keyboard.press('Escape');await page.click('#branch-button');await page.waitForSelector('[data-branch="feature-2"]');assert.equal(await loading(),false);
 await page.keyboard.press('Escape');hold.add('worktrees');await page.click('#repo-name');await page.waitForSelector('#worktree-popover [data-view-worktree]');await page.evaluate(()=>advancePicker(1000));assert.equal(await loading(),false);
 await page.keyboard.press('Escape');release('worktrees');
 assert.ok(calls.filter(c=>['worktrees','branches'].includes(c.kind)).every(c=>!c.requestId),'prefetch stays on pure-read transport');
 assert.deepEqual(errors,[]);
});
