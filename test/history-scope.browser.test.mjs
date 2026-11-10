import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_MODULE || (() => { throw new Error('Set PUPPETEER_MODULE to the absolute Puppeteer ESM module path.'); })()));

test('embedded history follows branch/worktree selection on desktop and mobile, fencing late reads', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gittygo-history-ui-')));
  const repo = path.join(root, 'repo'), linked = path.join(root, 'linked'); await fs.mkdir(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (where, ...args) => execFileSync('git', ['-C', where, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  const commit = async (where, subject) => { await fs.writeFile(path.join(where, 'file.txt'), subject); git(where, 'add', '.'); git(where, 'commit', '-qm', subject); return git(where, 'rev-parse', 'HEAD'); };
  const common = await commit(repo, 'Common ancestor');
  const main = await commit(repo, 'Dismiss errors after eight readable seconds');
  git(repo, 'update-ref', 'refs/remotes/origin/main', main);
  git(repo, 'switch', '-qc', 'feat/execution-ui', common);
  const feature = await commit(repo, 'Park distributed execution prototype for later review');
  git(repo, 'tag', 'feature-only-tag'); git(repo, 'update-ref', 'refs/remotes/origin/feature', feature);
  git(repo, 'switch', '-q', 'main');
  git(repo, 'branch', 'same-head');
  git(repo, 'worktree', 'add', '-qb', 'linked', linked, feature);
  const previous = process.env.GITTYGO_STATE_DIR; process.env.GITTYGO_STATE_DIR = path.join(root, 'state');
  const { startWorkspaceService } = require(process.env.GITTYGO_TEST_SERVICE || '../src/workspace-service.cjs');
  const token = 'disposable-history-token-12345678901234567890';
  const service = await startWorkspaceService({ token });
  const workspace = (await (await fetch(service.url + '/api/workspaces', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: repo }) })).json()).result;
  let heldReply = null, holdNextHistory = false, releaseHeld;
  const proxy = http.createServer((req, res) => {
    if (req.url === '/host') {
      res.setHeader('Content-Type', 'text/html'); res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><iframe style="border:0;width:100%;height:90vh" src="/w/${workspace.workspaceId}/?hostId=history-test"></iframe><script>document.querySelector('iframe').onload=()=>document.querySelector('iframe').contentWindow.postMessage({type:'gittygo:host-state',version:1,hostId:'history-test',visible:true},location.origin)</script>`); return;
    }
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const body = Buffer.concat(chunks); const method = body.length ? JSON.parse(body).method : null;
      const hold = holdNextHistory && ['history', 'readTarget'].includes(method);
      if (hold) holdNextHistory = false;
      const upstream = http.request(service.url + new URL(req.url, service.url).pathname, { method: req.method, headers: { Authorization: `Bearer ${token}`, ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) } }, reply => {
        if (!hold) { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); return; }
        const chunks = []; reply.on('data', b => chunks.push(b)); reply.on('end', () => {
          heldReply = JSON.parse(Buffer.concat(chunks));
          releaseHeld = () => { res.writeHead(reply.statusCode, reply.headers); res.end(Buffer.concat(chunks)); };
        });
      }); upstream.on('error', () => { res.writeHead(502); res.end(); }); upstream.end(body);
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  t.after(async () => { releaseHeld?.(); await browser.close(); await new Promise(resolve => proxy.close(resolve)); await service.close(); await fs.rm(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.GITTYGO_STATE_DIR; else process.env.GITTYGO_STATE_DIR = previous; });
  const waitHistory = async (frame, hashes) => {
    try { await frame.waitForFunction(hashes => JSON.stringify([...document.querySelectorAll('.commit-row')].map(el => el.dataset.commit)) === JSON.stringify(hashes), {}, hashes); }
    catch (error) { throw new Error(`${error.message}: ${JSON.stringify(await frame.evaluate(() => ({ root: model.repo?.repo, head: model.repo?.head, historyHead: model.historyHead, busy: model.busy, view: model.view, rows: [...document.querySelectorAll('.commit-row')].map(el => el.dataset.commit), toast: document.querySelector('#toast').textContent })))}`); }
  };
  for (const width of [1280, 390, 320]) await t.test(`${width}px`, async () => {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width, height: 900, isMobile: width < 700, hasTouch: width < 700 });
    await page.goto(`http://127.0.0.1:${proxy.address().port}/host`);
    const frame = page.frames().find(f => f.url().includes('/w/')); await frame.waitForSelector('#branch-name');
    await frame.click('[data-view="history"]'); await waitHistory(frame, [main, common]);
    assert.equal(await frame.$eval('#branch-name', el => el.textContent), 'main');
    assert.equal(await frame.$eval('#history-count', el => el.textContent), '2 commits');
    assert.doesNotMatch(await frame.$eval('#history-list', el => el.textContent), /Park distributed/);
    const switchBranch = async branch => {
      await frame.waitForFunction(() => !model.busy);
      await frame.click('#branch-button'); await frame.waitForSelector(`.branch-row[data-branch="${branch}"]`);
      await frame.click(`.branch-row[data-branch="${branch}"]`);
      await frame.waitForFunction(branch => model.repo?.branch === branch && !model.busy, {}, branch);
    };
    await switchBranch('feat/execution-ui'); await waitHistory(frame, [feature, common]);
    await frame.click(`.commit-row[data-commit="${feature}"]`); await frame.waitForSelector('.commit-detail');
    if (width < 700) await frame.click('#history-back');
    await switchBranch('main'); await waitHistory(frame, [main, common]);
    assert.equal(await frame.$('.commit-detail'), null, 'feature detail is not retained under main');
    await switchBranch('same-head'); await waitHistory(frame, [main, common]);
    await switchBranch('main');
    // The existing picker views a checked-out sibling instead of checking it out here.
    await frame.click('#branch-button'); await frame.waitForSelector('.branch-row[data-worktree]');
    await frame.click('.branch-row[data-worktree]');
    await frame.waitForFunction(root => model.repo?.repo === root && !navigatingWorktree && !model.busy && document.querySelector('#branch-popover').classList.contains('hidden') && document.querySelector('#worktree-popover').classList.contains('hidden'), {}, linked);
    await frame.click('[data-view="history"]'); await waitHistory(frame, [feature, common]);
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    await frame.click('#repo-name'); await frame.waitForSelector('[data-view-worktree]');
    await frame.evaluate(root => [...document.querySelectorAll('[data-view-worktree]')].find(el => el.dataset.viewWorktree === root).click(), repo);
    await frame.waitForFunction(root => model.repo?.repo === root && !navigatingWorktree && !model.busy && document.querySelector('#worktree-popover').classList.contains('hidden'), {}, repo); await waitHistory(frame, [main, common]);
    if (width === 1280) {
      // Hold an already-produced feature history response, then switch to main.
      // It must not overwrite the new main rows or stamp them with the new HEAD.
      await switchBranch('feat/execution-ui'); await waitHistory(frame, [feature, common]);
      holdNextHistory = true; heldReply = null; releaseHeld = null;
      await frame.evaluate(() => { window.staleHistory = loadHistory(); });
      while (!heldReply) await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(heldReply.result.map(c => c.hash), [feature, common]);
      git(repo, 'switch', '-q', 'main');
      await frame.evaluate(async () => renderRepo((await window.gittyGo.state()).result));
      await waitHistory(frame, [main, common]);
      releaseHeld(); releaseHeld = null; await frame.evaluate(() => window.staleHistory);
      await waitHistory(frame, [main, common]);
    }
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(os.tmpdir(), `gittygo-history-${width}.png`) });
    assert.deepEqual(errors, []); await page.close();
  });
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
