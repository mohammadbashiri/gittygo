// Real shared controller + renderer fixtures. Every Git/HOME/browser/native path is disposable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const modulePath = process.env.PUPPETEER_MODULE || (() => { throw new Error('Set PUPPETEER_MODULE to the absolute Puppeteer ESM module path.'); })();
const { default: puppeteer } = await import(pathToFileURL(modulePath));
const project = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gittygo-worktree-ui-')));
  const home = path.join(root, 'home'), repo = path.join(root, 'pi-app-workspace-integration'), linked = path.join(root, 'linked');
  await fs.mkdir(home); await fs.mkdir(repo);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GITTYGO_STATE_DIR: path.join(home, 'state') };
  const git = (where, ...args) => execFileSync('git', ['-C', where, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(repo, 'file.txt'), Array.from({ length: 90 }, (_, i) => `line ${i}`).join('\n') + '\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'seed');
  git(repo, 'worktree', 'add', '-qb', 'linked', linked);
  await fs.writeFile(path.join(repo, 'file.txt'), (await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).replace('line 2\n', 'main edit\n'));
  await fs.writeFile(path.join(linked, 'file.txt'), (await fs.readFile(path.join(linked, 'file.txt'), 'utf8')).replace('line 3\n', 'linked edit\n'));
  return { root, home, repo, linked, env, git };
}
async function select(page, root) {
  await page.waitForFunction(() => !model.busy && !navigatingWorktree);
  await page.click('#repo-name'); await page.waitForSelector('#worktree-popover [data-view-worktree]');
  // Warm menus no longer serialize unrelated history reads before the row click.
  await page.waitForFunction(()=>!model.busy&&!navigatingWorktree);
  await page.evaluate((root) => [...document.querySelectorAll('[data-view-worktree]')].find(el => el.dataset.viewWorktree === root).click(), root);
  try { await page.waitForFunction((root) => document.querySelector('#repo-name').textContent === root && document.querySelector('#modal-backdrop').classList.contains('hidden') && document.querySelector('#worktree-popover').classList.contains('hidden'), {}, root); }
  catch (e) { throw new Error(`${e.message} ${JSON.stringify(await page.evaluate(() => ({ repo: model.repo?.repo, busy: model.busy, navigatingWorktree, toast: document.querySelector('#toast').textContent, modal: document.querySelector('#modal-backdrop').className })))}`); }
}
async function scenario(page, f) {
  await page.waitForSelector('.file-row');
  assert.equal(await page.evaluate(() => !!window.gittyGo.selectWorktree), true);
  await page.type('#commit-message', 'main draft');
  await page.locator('.file-row[data-file-key^="unstaged:"]').click(); await page.waitForSelector('.diff-row');
  await page.waitForFunction(() => !model.busy);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.locator('.diff-row.del').click();
  await page.waitForSelector('#selection-action:not(.hidden)');
  await page.click('#add-comment'); await page.type('.comment-composer textarea', 'main comment draft');
  const count = await page.$eval('#selection-count', el => el.textContent);
  await select(page, f.linked);
  assert.equal(await page.$eval('#commit-message', el => el.value), '');
  await page.type('#commit-message', 'linked draft');
  await page.locator('.file-row[data-file-key^="unstaged:"]').click(); await page.waitForSelector('.diff-row');
  assert.ok(await page.$eval('#content', el => el.textContent.includes('linked edit')));
  await select(page, f.repo);
  assert.equal(await page.$eval('#commit-message', el => el.value), 'main draft');
  assert.equal(await page.$eval('.comment-composer textarea', el => el.value), 'main comment draft');
  assert.equal(await page.$eval('#selection-count', el => el.textContent), count);
  // Branch checked out elsewhere is a view action, not a switch attempt.
  await page.click('#branch-button'); await page.waitForSelector('.branch-row[data-worktree]');
  assert.ok(await page.$eval('.branch-row[data-worktree]', el => el.textContent.includes('View worktree')));
  await page.click('.branch-row[data-worktree]'); await page.waitForFunction((root) => document.querySelector('#repo-name').textContent === root, {}, f.linked);
  assert.equal(await page.$eval('#commit-message', el => el.value), 'linked draft');
  const stage = await page.evaluate(() => window.gittyGo.stageFile('file.txt')); assert.equal(stage.ok, true, JSON.stringify(stage));
  const commit = await page.evaluate(() => window.gittyGo.commit('linked UI proof', false)); assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(f.git(f.repo, 'log', '-1', '--format=%s'), 'seed');
  assert.equal(f.git(f.linked, 'log', '-1', '--format=%s'), 'linked UI proof');
  await page.click('[data-view="history"]'); await page.waitForSelector('.commit-row');
  assert.ok(await page.$eval('#history-list', el => el.textContent.includes('linked UI proof')));
  await select(page, f.repo); assert.equal(await page.$eval('#commit-message', el => el.value), 'main draft');
  assert.equal(f.git(f.repo, 'diff', '--cached'), '');
}

test('actual browser service worktrees, drafts, branch-in-use navigation, confirmations and explicit init', async (t) => {
  const f = await fixture(); const previous = process.env.GITTYGO_STATE_DIR; process.env.GITTYGO_STATE_DIR = f.env.GITTYGO_STATE_DIR;
  const { startWorkspaceService } = require('../src/workspace-service.cjs');
  const token = 'disposable-test-token-12345678901234567890';
  const service = await startWorkspaceService({ token });
  const proxy = http.createServer(async (req, res) => {
    const upstream = http.request(service.url + req.url, { method: req.method, headers: { Authorization: `Bearer ${token}`, ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) } }, (reply) => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const register = async (directory) => (await (await fetch(service.url + '/api/workspaces', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ directory }) })).json()).result;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => proxy.close(resolve)); await service.close(); await fs.rm(f.root, { recursive: true, force: true }); if (previous === undefined) delete process.env.GITTYGO_STATE_DIR; else process.env.GITTYGO_STATE_DIR = previous; });
  const workspace = await register(f.repo); const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 850 });
  await page.goto(`http://127.0.0.1:${proxy.address().port}/w/${workspace.workspaceId}/`);
  await scenario(page, f);
  await page.click('#repo-name'); await page.waitForSelector('#manage-worktrees');
  assert.equal(await page.$('#create-worktree-form'),null,'navigation picker does not expose management form');
  assert.equal(await page.$('[data-remove-worktree]'),null,'navigation picker does not expose removal');
  await page.click('#manage-worktrees'); await page.waitForSelector('#create-worktree-form');
  await page.type('#worktree-folder', 'created'); await page.type('#worktree-branch', 'created-branch'); await page.click('#create-worktree-form button');
  await page.waitForSelector('.confirmation-dialog');
  assert.ok(await page.$eval('.confirmation-dialog', (el, root) => el.textContent.includes(root), path.join(f.root, 'created')));
  await page.click('.confirmation-dialog button:last-child');
  await page.waitForFunction(() => document.querySelector('.worktree-list')?.textContent.includes('created-branch'));
  assert.equal(f.git(path.join(f.root, 'created'), 'branch', '--show-current'), 'created-branch');
  await page.evaluate((root) => [...document.querySelectorAll('[data-remove-worktree]')].find(el => el.dataset.removeWorktree === root).click(), path.join(f.root, 'created'));
  await page.waitForSelector('.confirmation-dialog'); await page.click('.confirmation-dialog button:last-child');
  await page.waitForFunction(() => !document.querySelector('.worktree-list')?.textContent.includes('created-branch'));
  assert.equal(await fs.stat(path.join(f.root, 'created')).catch(() => null), null);
  await page.click('#close-modal');
  const longBranch='feature/workspace-integration-with-a-long-branch-name';
  f.git(f.repo,'branch','-m',longBranch);
  await page.waitForFunction(name=>document.querySelector('#branch-name').textContent===name,{},longBranch);
  for(const width of [320,390,768,1280]){
    await page.setViewport({width,height:850,isMobile:width<701,hasTouch:width<701});
    // Puppeteer reloads when mobile emulation changes; wait for the real header.
    await page.waitForFunction(name=>document.querySelector('#branch-name').textContent===name,{},longBranch);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const layout=await page.evaluate(()=>{const box=id=>{const b=document.querySelector(id).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};return {path:box('#repo-name'),branch:box('#branch-button'),more:box('#more-button'),header:box('.titlebar'),syncInHeader:!!document.querySelector('.titlebar #sync-state')};});
    assert.ok(layout.more.right<=width);assert.equal(await page.$('#fetch-button'),null,'Fetch remains only under More');
    assert.equal(layout.syncInHeader,false,'upstream detail no longer consumes header space');
    assert.equal(await page.$('#worktree-button'),null,'no redundant Worktrees header button');
    if(width<=700){assert.ok(layout.path.bottom<=layout.branch.y+2,'phone folder and branch have distinct rows');assert.ok(layout.path.width>=width-120,'path gets useful first-row width');assert.ok(layout.branch.width>=width-24,'branch gets full second-row width');assert.ok(layout.branch.bottom<=layout.header.bottom+1);}
    const chevrons=await page.evaluate(()=>['#repo-name','#branch-button'].map(s=>{const el=document.querySelector(s),label=el.querySelector(s==='#repo-name'?'.path-label':'#branch-name'),a=el.getBoundingClientRect(),b=label.getBoundingClientRect(),c=getComputedStyle(el,'::after');return {gap:parseFloat(getComputedStyle(el).columnGap),labelEnd:b.right-a.left,center:b.y+b.height/2-(a.y+a.height/2),mask:c.maskImage,width:c.width,content:c.content};}));
    assert.equal(chevrons[0].mask,chevrons[1].mask);assert.match(chevrons[0].mask,/svg/);for(const c of chevrons){assert.equal(c.width,'12px');assert.equal(c.gap,6);assert.ok(Math.abs(c.center)<2,'label and chevron align vertically');}
    await page.click('#repo-name');await page.waitForSelector('#worktree-popover [data-view-worktree][aria-current="location"]');
    assert.equal(await page.$eval('#worktree-picker-title',el=>el.textContent),'Working folders');
    assert.equal(await page.$eval('#modal-backdrop',el=>el.classList.contains('hidden')),true,'folder navigation is not modal');
    assert.ok(await page.$eval('#worktree-popover [aria-current="location"]',el=>el.textContent.includes('Currently viewing')));
    assert.equal(await page.$('#worktree-popover #create-worktree-form'),null);assert.equal(await page.$('#worktree-popover [data-remove-worktree]'),null);
    assert.ok(await page.$eval('#worktree-popover',el=>{const b=el.getBoundingClientRect();return b.x>=0&&b.right<=innerWidth&&b.bottom<=innerHeight&&b.y>=document.querySelector('#repo-name').getBoundingClientRect().bottom;}));
    if(process.env.GITTYGO_SCREENSHOTS){await fs.mkdir(process.env.GITTYGO_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.GITTYGO_SCREENSHOTS,'working-folders-'+width+'.png')});}
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedPath=text;}}}));
    await page.click('#worktree-popover #copy-worktree-path');assert.equal(await page.evaluate(()=>window.copiedPath),f.repo);
    await page.keyboard.press('Escape');assert.equal(await page.$eval('#repo-name',el=>el.getAttribute('aria-expanded')),'false');assert.equal(await page.evaluate(()=>document.activeElement.id),'repo-name');
    if(process.env.GITTYGO_SCREENSHOTS)await page.screenshot({path:path.join(process.env.GITTYGO_SCREENSHOTS,'header-'+width+'.png')});
    await page.click('#branch-button');await page.waitForSelector('#branch-popover .branch-row');
    assert.equal(await page.$eval('#repo-name',el=>el.getAttribute('aria-expanded')),'false');
    assert.ok(await page.$eval('#branch-popover',el=>{const b=el.getBoundingClientRect();return b.x>=0&&b.right<=innerWidth&&b.bottom<=innerHeight&&b.y>=document.querySelector('#branch-button').getBoundingClientRect().bottom;}));
    await page.click('#repo-name');await page.waitForSelector('#worktree-popover [data-view-worktree]');assert.ok(await page.$eval('#branch-popover',el=>el.classList.contains('hidden')));
    await page.click('#repo-name');assert.ok(await page.$eval('#worktree-popover',el=>el.classList.contains('hidden')));
    await page.click('#more-button');assert.ok(await page.$('#more-menu [data-command="fetch"]'));await page.keyboard.press('Escape');
  }
  await page.setViewport({width:320,height:800,isMobile:true,hasTouch:true});
  // A delayed folder-list reply must not overwrite a newly opened modal.
  await page.setRequestInterception(true);let holdFolders=true;
  const intercept=request=>{if(holdFolders&&request.url().endsWith('/rpc')&&JSON.parse(request.postData()||'{}').method==='worktrees')return;void request.continue();};
  page.on('request',intercept);
  const pendingFolders=page.waitForRequest(r=>r.url().endsWith('/rpc')&&JSON.parse(r.postData()||'{}').method==='worktrees');
  await page.click('#repo-name');const heldFolders=await pendingFolders;await page.click('#close-worktrees');
  await page.click('#more-button');await page.click('[data-command="remotes"]');await page.waitForSelector('.add-remote');
  holdFolders=false;await heldFolders.continue();await page.waitForNetworkIdle({idleTime:200});
  assert.equal(await page.$eval('#modal-title',el=>el.textContent),'Manage remotes');assert.ok(await page.$('.add-remote'));assert.equal(await page.$('.worktree-list'),null);
  await page.click('#close-modal');page.off('request',intercept);await page.setRequestInterception(false);
  const nonrepo = path.join(f.root, 'not-git'); await fs.mkdir(nonrepo); await fs.writeFile(path.join(nonrepo, 'keep'), 'preserve');
  const non = await register(nonrepo); await page.goto(`http://127.0.0.1:${proxy.address().port}/w/${non.workspaceId}/`);
  await page.waitForSelector('#non-repository:not(.hidden)'); assert.equal(await fs.stat(path.join(nonrepo, '.git')).catch(() => null), null);
  await page.click('#initialize-repository'); await page.waitForSelector('.confirmation-dialog'); await page.click('.confirmation-dialog button:first-child');
  assert.equal(await fs.stat(path.join(nonrepo, '.git')).catch(() => null), null);
  await page.click('#initialize-repository'); await page.waitForSelector('.confirmation-dialog'); await page.click('.confirmation-dialog button:last-child');
  await page.waitForSelector('.file-row'); assert.equal(await fs.readFile(path.join(nonrepo, 'keep'), 'utf8'), 'preserve');
  assert.deepEqual(errors, []);
});

test('actual native Electron preload/IPC worktree navigation retains drafts and targets linked commits', async (t) => {
  const f = await fixture(); let child, browser;
  t.after(async () => { browser?.disconnect(); if (child && child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await fs.rm(f.root, { recursive: true, force: true }); });
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const bootstrap = path.join(f.root, 'bootstrap.cjs');
  await fs.writeFile(bootstrap, `const {app}=require('electron'); app.on('browser-window-created',(_e,w)=>w.hide()); require(${JSON.stringify(path.join(project, 'src/main.cjs'))});`);
  child = spawn(require('electron'), [bootstrap, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${f.home}/gui`, '--', f.repo], { env: f.env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}`);
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(browser); let page;
  for (let i = 0; i < 100; i++) { page = (await browser.pages()).find(p => p.url().includes('/renderer/index.html')); if (page) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(page); const errors = []; page.on('pageerror', e => errors.push(e.message));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('browser-host')), false);
  await scenario(page, f); assert.deepEqual(errors, []);
});
