// Disposable Electron native preload/IPC proof; only OS-dialog presentation is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_MODULE || (() => { throw new Error('Set PUPPETEER_MODULE to the absolute Puppeteer ESM module path.'); })()));

test('actual native non-repo window offers explicit init; Cancel and confirmed init preserve files', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gittygo-native-nonrepo-')));
  const home = path.join(root, 'home'), folder = path.join(root, 'folder'); await fs.mkdir(home); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'keep'), 'preserved');
  let child, browser;
  t.after(async () => { browser?.disconnect(); if (child && child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await fs.rm(root, { recursive: true, force: true }); });
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const main = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/main.cjs');
  const bootstrap = path.join(root, 'bootstrap.cjs');
  await fs.writeFile(bootstrap, `const {app,dialog}=require('electron'); let calls=0; dialog.showMessageBox=async(_window,spec)=>{if(spec.title!=='Initialize Repository?'||!spec.message.includes(${JSON.stringify(folder)})) throw Error('Unexpected native dialog'); return {response:calls++===0?0:1};}; app.on('browser-window-created',(_e,w)=>w.hide()); require(${JSON.stringify(main)});`);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GITTYGO_STATE_DIR: path.join(home, 'state') };
  child = spawn(require('electron'), [bootstrap, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${home}/gui`, '--', folder], { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error(`Electron exited ${child.exitCode}`); try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  assert.ok(browser); let page;
  for (let i = 0; i < 100; i++) { page = (await browser.pages()).find(p => p.url().includes('/renderer/index.html')); if (page) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(page); await page.waitForSelector('#non-repository:not(.hidden)');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('browser-host')), false);
  assert.equal(await fs.stat(path.join(folder, '.git')).catch(() => null), null);
  await page.click('#initialize-repository'); await page.waitForFunction(() => !model.busy);
  assert.equal(await fs.stat(path.join(folder, '.git')).catch(() => null), null);
  await page.click('#initialize-repository'); await page.waitForSelector('.file-row');
  assert.ok(await fs.stat(path.join(folder, '.git'))); assert.equal(await fs.readFile(path.join(folder, 'keep'), 'utf8'), 'preserved');
  assert.equal((await page.evaluate(() => window.gittyGo.state())).result.staged.length, 0);
});
