import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { default: puppeteer } = await import(process.env.PUPPETEER_MODULE || (() => { throw new Error('Set PUPPETEER_MODULE to the absolute Puppeteer ESM module path.'); })());

test('removed selected worktree recovers through real folder picker, preserving drafts and native entry', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gittygo-recovery-ui-')));
  const previous = process.env.GITTYGO_STATE_DIR; process.env.GITTYGO_STATE_DIR = path.join(root, 'state');
  const repo = path.join(root, 'repo'), linked = path.join(root, 'linked'); await fs.mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(repo, 'file'), 'seed\n'); git('add', '.'); git('commit', '-qm', 'seed'); git('worktree', 'add', '-qb', 'linked', linked);
  const branch = git('branch', '--show-current');
  const token = 'disposable-recovery-token-12345678901234567890';
  const service = await require('../src/workspace-service.cjs').startWorkspaceService({ token });
  const proxy = http.createServer((req,res) => { const upstream = http.request(service.url + req.url, {method:req.method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}}, reply => {res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);}); upstream.on('error',()=>{res.writeHead(502);res.end();}); req.pipe(upstream); });
  await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
  const browser = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  t.after(async()=>{await browser.close();await new Promise(resolve=>proxy.close(resolve));await service.close();await fs.rm(root,{recursive:true,force:true});if(previous===undefined)delete process.env.GITTYGO_STATE_DIR;else process.env.GITTYGO_STATE_DIR=previous;});
  const registration = await (await fetch(service.url+'/api/workspaces',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({directory:repo})})).json();
  const page = await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const url=`http://127.0.0.1:${proxy.address().port}/w/${registration.result.workspaceId}/`;
  await page.goto(url);await page.waitForFunction(root=>model.repo?.repo===root,{},repo);
  await page.type('#commit-message','main draft');
  await page.evaluate(async root=>viewWorktree(root),linked);
  await page.type('#commit-message','removed folder draft');
  git('worktree','remove',linked);
  // Same runtime refresh, without reconstructing the renderer or its drafts.
  await page.evaluate(async()=>renderRepo((await window.gittyGo.state()).result));
  await page.waitForSelector('#unavailable-worktree:not(.hidden)');
  assert.equal(await page.$eval('#commit-message',e=>e.value),'removed folder draft');
  assert.equal(await page.$eval('#changes-view',e=>e.classList.contains('hidden')),true);
  assert.equal(await page.evaluate(async()=> (await window.gittyGo.stageAll()).ok),false);
  // A new iframe must also show the recovery state instead of the blank shell.
  const fresh=await browser.newPage();await fresh.goto(url);await fresh.waitForSelector('#unavailable-worktree:not(.hidden)');await fresh.close();
  for(const width of [320,1280]){
    await page.setViewport({width,height:850});
    await page.click('#choose-available-worktree');
    await page.waitForSelector('#worktree-popover [data-view-worktree]');
    assert.equal(await page.$eval('#worktree-popover',e=>e.getBoundingClientRect().right<=innerWidth),true);
    if(width===320){await page.keyboard.press('Escape');continue;}
    await page.evaluate(root=>[...document.querySelectorAll('#worktree-popover [data-view-worktree]')].find(e=>e.dataset.viewWorktree===root).click(),repo);
  }
  await page.waitForFunction(root=>model.repo?.repo===root&&!navigatingWorktree,{},repo);
  assert.equal(await page.$eval('#commit-message',e=>e.value),'main draft');
  assert.equal(await page.evaluate(root=>worktreeViews.get(root).message,linked),'removed folder draft');
  assert.equal(git('branch','--show-current'),branch);assert.equal(git('diff','--cached'),'');
  assert.deepEqual(errors,[]);
});
