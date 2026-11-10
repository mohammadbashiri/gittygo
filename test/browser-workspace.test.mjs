// Disposable HTTP fixture only: no Git, credentials, owner profile or native runtime.
// PUPPETEER_MODULE may point to an existing Puppeteer ESM module; no install needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.PUPPETEER_MODULE || (() => { throw new Error('Set PUPPETEER_MODULE to the absolute Puppeteer ESM module path.'); })();
const { default: puppeteer } = await import(pathToFileURL(modulePath));
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const file = { path: '<img src=x onerror=alert(1)>.txt', section: 'unstaged', status: 'M' };
const patch = 'diff --git a/test b/test\n--- a/test\n+++ b/test\n@@ -1,2 +1,2 @@\n-old\n+<script>alert(1)</script>\n context\n';
const diff = { patch, hunks: [{ id: 0, header: '@@ -1,2 +1,2 @@', patch, lines: ['-old', '+<script>alert(1)</script>', ...Array.from({ length: 80 }, (_, i) => ` context ${i}`)] }] };
const commit = { hash: 'abcdef123', shortHash: 'abcdef1', parents: [], author: '<img src=x>', date: '2026-06-01', subject: 'Fixture commit', refs: [] };

test('browser facade and responsive workspace against isolated RPC', async (t) => {
  const calls = []; let comments = []; let revision = 0; let interruptStage = false;
  let currentDiff = diff, fileViewLimit = 30, fixtureFiles = null;
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://fixture.test').pathname;
    if (pathname === '/host') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><iframe id="workspace" src="/embed/w/fake/?hostId=fixture-host"></iframe><iframe id="sibling" src="about:blank"></iframe>'); return;
    }
    if (req.method === 'POST' && req.url === '/embed/w/fake/rpc') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { method, args, requestId } = JSON.parse(body); calls.push({ method, args, requestId });
      if (method === 'stageAll' && interruptStage === 'empty') { req.socket.destroy(); return; }
      if (method === 'stageAll' && interruptStage) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); setTimeout(() => res.destroy(), 20); return; }
      let result = null;
      if (method === 'state') result = { name: '<img src=x>', branch: 'feature/long-branch-name', head: 'abcdef123', changes: fixtureFiles?.changes ?? [file], staged: fixtureFiles?.staged ?? [{ ...file, section: 'staged' }], indexMtimeMs: revision };
      if (method === 'reviewState') result = { comments, openCommentCount: comments.length };
      if (method === 'uiRequests') result = {};
      if (method === 'diff' || method === 'commitFileDiff') result = currentDiff;
      if (method === 'commit') result = 'cafebabe';
      if (method === 'history') result = [commit];
      if (method === 'commitDetails') result = { ...commit, message: commit.subject, email: 'fixture@example.test', comparison: { kind: 'root' }, totals: { files: 1, additions: 1, deletions: 1 }, files: [file] };
      if (method === 'branches') result = [{ name: 'main', current: true }, { name: '<img src=x>', current: false }];
      if (method === 'remotes') result = [{ name: 'origin', fetchUrl: 'https://example.test/repo', pushUrl: 'https://example.test/repo' }];
      if (method === 'addReviewComment') { comments = [{ id: 'comment-1', anchor: args[0], body: args[1], status: 'open' }]; result = { comments, openCommentCount: 1 }; }
      if (method === 'editReviewComment') { comments[0].body = args[1]; result = { comments, openCommentCount: 1 }; }
      if (method === 'resolveReviewComment') { comments = []; result = { comments, openCommentCount: 0 }; }
      if (method === 'confirm') result = args[1] === 0 ? { cancelled: true } : 'done';
      const response = ['discardFile', 'discardHunk', 'undoCommit', 'pull', 'push', 'removeRemote'].includes(method)
        ? { ok: true, confirmation: { id: 'opaque-fixture', title: 'Review operation', message: '<img src=x onerror=alert(1)>', detail: 'Only an explicit choice may proceed.', choices: ['Cancel', 'Proceed'] } }
        : { ok: true, result };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response)); return;
    }
    const name = pathname.split('/').pop() || 'index.html';
    if (!['index.html', 'renderer.js', 'browser-adapter.js', 'styles.css'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    const contents = await readFile(new URL(`../src/renderer/${name}`, import.meta.url), 'utf8');
    // Exercise the production eviction algorithm with a small capacity, without
    // a production test hook or generating dozens of unrelated fixture files.
    res.end(name === 'renderer.js' ? contents.replace('const FILE_VIEW_LIMIT = 30;', `const FILE_VIEW_LIMIT = ${fileViewLimit};`) : contents);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const width of [320, 390, 1280]) await t.test(`${width}px interactions`, async () => {
    comments = []; const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width, height: 800, isMobile: width < 700, hasTouch: width < 700 });
    await page.goto(`${origin}/embed/w/fake/`);
    await page.waitForSelector('.file-row');
    await page.type('#commit-message', 'Keep my commit draft');
    await page.click('.file-row[data-file-key^="unstaged:"]'); await page.waitForSelector('.diff-row');
    assert.equal(await page.$eval('#repo-name', el => el.textContent), '<img src=x>');
    assert.equal(await page.$eval('#content', el => el.querySelectorAll('script,img').length), 0);
    if (width < 700) {
      assert.equal(await page.$eval('.sidebar', el => getComputedStyle(el).display), 'none');
      await page.click('.diff-row[data-line="1"]');
      assert.equal(await page.$eval('#selection-action', el => getComputedStyle(el).display), 'none');
      await page.click('#line-selection-mode');
      const client = await page.createCDPSession();
      const bounds = await page.$eval('#content', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [bounds] });
      for (let step = 1; step <= 8; step++) { await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x, y: bounds.y - step * 15 }] }); await pause(20); }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pause(250);
      assert.ok(await page.$eval('#content', el => el.scrollTop > 0), 'touch scroll remains native in selection mode');
      assert.equal(await page.$eval('#selection-action', el => getComputedStyle(el).display), 'none', 'scroll did not select lines');
      await page.$eval('#content', el => { el.scrollTop = 0; }); await client.detach();
    }
    await page.click('.diff-row[data-line="0"]');
    if (width < 700) await page.click('#line-range-mode'); else await page.keyboard.down('Shift');
    await page.click('.diff-row[data-line="1"]');
    if (width >= 700) await page.keyboard.up('Shift');
    assert.equal(await page.$eval('#selection-count', el => el.textContent), '2 lines selected');
    await page.click('#apply-selection'); await pause(150);
    assert.deepEqual(calls.filter(c => c.method === 'stageSelected').at(-1).args[1], [0, 1]);
    if (width < 700) await page.click('#line-range-mode');
    await page.click('.toggle-hunk'); await pause(150);
    assert.ok(calls.some(c => c.method === 'stageHunk'));
    await page.click('.diff-row[data-line="1"]');
    await page.click('#add-comment'); await page.type('.comment-composer textarea', 'draft <img src=x>');
    // External state/review changes must preserve editor value, caret, and reading position.
    await page.evaluate(() => { document.querySelector('#content').scrollTop = 55; document.querySelector('.comment-composer textarea').setSelectionRange(4, 4); });
    revision++; await pause(2300);
    assert.equal(await page.$eval('.comment-composer textarea', el => el.value), 'draft <img src=x>');
    assert.equal(await page.$eval('#content', el => el.scrollTop), 55);
    assert.equal(await page.$eval('.comment-composer textarea', el => el.selectionStart), 4);
    await page.click('[data-comment-action="save"]'); await page.waitForSelector('.review-thread');
    assert.equal(await page.$eval('.review-thread p', el => el.textContent), 'draft <img src=x>');
    assert.equal(await page.$eval('.review-thread', el => el.querySelectorAll('img').length), 0);
    await page.click('[data-review-action="edit"]'); await page.type('.comment-composer textarea', ' edited'); await page.click('[data-comment-action="save"]');
    await page.waitForFunction(() => !document.querySelector('.comment-composer'));
    await pause(200);
    await page.click('[data-review-action="resolve"]');
    await page.waitForFunction(() => !document.querySelector('.review-thread'));
    const before = calls.filter(c => c.method === 'confirm').length;
    await page.click('#discard-file'); await page.waitForSelector('dialog[open]');
    assert.equal(calls.filter(c => c.method === 'confirm').length, before);
    assert.equal(await page.$eval('dialog', el => el.querySelectorAll('img').length), 0);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog'));
    assert.equal(calls.filter(c => c.method === 'confirm').at(-1).args[1], 0);
    await page.click('#discard-file'); await page.waitForSelector('dialog[open]'); await page.click('dialog button:last-child');
    await page.waitForFunction(() => !document.querySelector('dialog'));
    assert.equal(calls.filter(c => c.method === 'confirm').at(-1).args[1], 1);
    if (width < 700) await page.click('#back-to-files');
    assert.equal(await page.$eval('#commit-message', el => el.value), 'Keep my commit draft');
    await page.click('.file-row[data-file-key^="staged:"]'); await page.waitForSelector('.diff-row');
    await page.click('.toggle-hunk'); await pause(150);
    assert.ok(calls.some(c => c.method === 'unstageHunk'));
    await page.click('.diff-row[data-line="1"]'); await page.click('#apply-selection'); await pause(150);
    assert.equal(calls.filter(c => c.method === 'stageSelected').at(-1).args[2], 'staged');
    await page.click('#file-action'); await pause(100); assert.ok(calls.some(c => c.method === 'unstageFile'));
    if (width < 700) await page.click('#back-to-files');
    await page.click('#commit-button'); await page.waitForFunction(() => document.querySelector('#commit-message').value === '');
    await page.click('#amend-checkbox'); await page.click('#commit-button'); await pause(150);
    assert.deepEqual(calls.filter(c => c.method === 'commit').at(-1).args, ['', true]);
    await page.click('[data-view="history"]'); await page.waitForSelector('.commit-row'); await page.click('.commit-row'); await page.waitForSelector('.commit-file-row');
    if (width < 700) await page.click('.commit-file-row');
    await page.waitForSelector('#commit-file-content .diff');
    if (width < 700) { await page.click('#history-back'); await page.click('#history-back'); }
    await page.click('#branch-button'); await page.waitForSelector('.branch-row');
    assert.equal(await page.$eval('#branch-list', el => el.querySelectorAll('img').length), 0);
    await page.click('#close-branches'); await page.click('#more-button'); await page.click('[data-command="remotes"]'); await page.waitForSelector('#remote-url');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/gittygo-browser-${width}.png` });
    await page.close();
  });
  await t.test('native preload remains untouched', async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/embed/w/fake/`);
    assert.equal(await page.evaluate(async () => {
      const native = { marker: 'native' }; window.gittyGo = native;
      const script = document.createElement('script'); script.src = 'browser-adapter.js'; document.body.append(script);
      await new Promise(resolve => { script.onload = resolve; }); return window.gittyGo === native;
    }), true);
    await page.close();
  });
  await t.test('hidden-page polling stops; wake refreshes; uncertain mutation never retries', async () => {
    const page = await browser.newPage(); await page.goto(`${origin}/embed/w/fake/`); await page.waitForSelector('.file-row'); await pause(200);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.fixtureHidden }); window.fixtureHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await pause(200); const before = calls.filter(c => c.method === 'state').length; await pause(2200);
    assert.equal(calls.filter(c => c.method === 'state').length, before);
    await page.evaluate(() => { window.fixtureHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await pause(200); assert.ok(calls.filter(c => c.method === 'state').length > before);
    interruptStage = 'partial'; const mutationCount = calls.filter(c => c.method === 'stageAll').length;
    const response = await page.evaluate(() => window.gittyGo.stageAll());
    assert.equal(response.ok, false);
    assert.match(response.error.message, /Outcome unconfirmed; check current state before repeating/);
    assert.doesNotMatch(response.error.message, /not retried|not executed/);
    await pause(2300);
    assert.equal(calls.filter(c => c.method === 'stageAll').length, mutationCount + 1);
    // Chromium may replay a POST itself on a pre-header socket drop. The wire
    // replays MUST share the original ID so the real service can deduplicate.
    interruptStage = 'empty'; const start = calls.length;
    assert.equal((await page.evaluate(() => window.gittyGo.stageAll())).ok, false);
    await pause(2300);
    const retransmissions = calls.slice(start).filter(c => c.method === 'stageAll');
    assert.ok(retransmissions.length >= 1);
    assert.equal(new Set(retransmissions.map(c => c.requestId)).size, 1);
    assert.notEqual(retransmissions[0].requestId, calls.filter(c => c.method === 'stageAll')[mutationCount].requestId);
    await page.close();
  });
  await t.test('same-origin iframe host visibility is authenticated and gates polling', async () => {
    const page = await browser.newPage(); await page.goto(`${origin}/host`);
    const frame = page.frames().find(candidate => candidate.url().includes('hostId='));
    await frame.waitForSelector('.file-row'); await pause(200);
    let before = calls.filter(c => c.method === 'state').length;
    await pause(2200);
    assert.equal(calls.filter(c => c.method === 'state').length, before, 'opted-in iframe starts polling-paused');
    await page.evaluate(() => {
      const data = { type: 'gittygo:host-state', version: 1, hostId: 'fixture-host', visible: true };
      document.querySelector('#workspace').contentWindow.postMessage({ ...data, hostId: 'wrong-host' }, location.origin);
      document.querySelector('#sibling').contentWindow.eval(`parent.frames[0].postMessage(${JSON.stringify(data)}, parent.location.origin)`);
    });
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'gittygo:host-state', version: 1, hostId: 'fixture-host', visible: true }, source: parent, origin: 'https://spoof.invalid' })));
    await pause(2200);
    assert.equal(calls.filter(c => c.method === 'state').length, before, 'wrong source/origin/hostId cannot enable polling');
    await page.evaluate(() => document.querySelector('#workspace').contentWindow.postMessage({ type: 'gittygo:host-state', version: 1, hostId: 'fixture-host', visible: true }, location.origin));
    await pause(200); assert.ok(calls.filter(c => c.method === 'state').length > before, 'shown host refreshes immediately');
    await page.evaluate(() => {
      const frame = document.querySelector('#workspace'); frame.style.display = 'none';
      frame.contentWindow.postMessage({ type: 'gittygo:host-state', version: 1, hostId: 'fixture-host', visible: false }, location.origin);
    });
    await pause(200);
    assert.equal(await frame.evaluate(() => document.hidden), false, 'CSS-hidden iframe does not report document.hidden');
    before = calls.filter(c => c.method === 'state').length; await pause(2200);
    assert.equal(calls.filter(c => c.method === 'state').length, before, 'CSS-hidden host does not poll');
    await page.evaluate(() => {
      const frame = document.querySelector('#workspace'); frame.style.display = '';
      frame.contentWindow.postMessage({ type: 'gittygo:host-state', version: 1, hostId: 'fixture-host', visible: true }, location.origin);
    });
    await pause(200); assert.ok(calls.filter(c => c.method === 'state').length > before);
    await page.close();
  });
  await t.test('external diff change retains draft but requires explicit new location', async () => {
    comments = []; currentDiff = diff;
    const page = await browser.newPage(); await page.goto(`${origin}/embed/w/fake/`); await page.waitForSelector('.file-row');
    await page.click('.file-row[data-file-key^="unstaged:"]'); await page.waitForSelector('.diff-row');
    await page.click('.diff-row[data-line="1"]'); await page.click('#add-comment'); await page.type('.comment-composer textarea', 'Keep this draft across replacement');
    const newPatch = patch.replace('+<script>alert(1)</script>', '+different replacement');
    // Deliberately reuse the same numeric hunk ID/header/line index: these are
    // not sufficient evidence that a comment anchor still refers to that change.
    currentDiff = { patch: newPatch, hunks: [{ ...diff.hunks[0], patch: newPatch, lines: ['-unrelated old', '+different replacement', ' context'] }] }; revision++;
    await page.waitForSelector('.draft-warning');
    assert.equal(await page.$eval('.comment-composer textarea', el => el.value), 'Keep this draft across replacement');
    assert.equal(await page.$eval('.comment-composer', el => Boolean(el.closest('.hunk'))), false);
    assert.equal(await page.$eval('[data-comment-action="save"]', el => el.disabled), true);
    const before = calls.filter(c => c.method === 'addReviewComment').length;
    await page.$eval('[data-comment-action="save"]', el => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await pause(100); assert.equal(calls.filter(c => c.method === 'addReviewComment').length, before);
    await page.click('.diff-row[data-line="1"]'); await page.click('[data-comment-action="reanchor"]');
    assert.equal(await page.$('.draft-warning'), null);
    await page.click('[data-comment-action="save"]'); await page.waitForSelector('.review-thread');
    assert.deepEqual(calls.filter(c => c.method === 'addReviewComment').at(-1).args[0].selectedText, ['different replacement']);
    assert.equal(calls.filter(c => c.method === 'addReviewComment').at(-1).args[1], 'Keep this draft across replacement');
    await page.close(); currentDiff = diff; comments = [];
  });
  await t.test('small-capacity file-view cache refuses dirty eviction and evicts clean views first', async () => {
    fileViewLimit = 2;
    const page = await browser.newPage(); await page.goto(`${origin}/embed/w/fake/`); await page.waitForSelector('.file-row');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const makeDraft = async (path, body) => {
      await page.evaluate(async path => { await selectFile({ path, section: 'unstaged', status: 'M' }); }, path);
      await page.click('.diff-row[data-line="1"]'); await page.click('#add-comment'); await page.type('.comment-composer textarea', body);
    };
    await makeDraft('draft-one.txt', 'first unsaved body'); await makeDraft('draft-two.txt', 'second unsaved body');
    await page.evaluate(() => selectFile({ path: 'third.txt', section: 'unstaged', status: 'M' }));
    assert.equal(await page.$eval('#selected-path', el => el.textContent), 'draft-two.txt', 'opening third is refused rather than losing dirty bodies');
    assert.match(await page.$eval('#toast', el => el.textContent), /Draft limit reached/);
    assert.equal(await page.evaluate(() => fileViews.size), 2);
    assert.equal(await page.$eval('.comment-composer textarea', el => el.value), 'second unsaved body');
    await page.click('[data-comment-action="cancel"]');
    await page.evaluate(() => selectFile({ path: 'third.txt', section: 'unstaged', status: 'M' }));
    assert.equal(await page.$eval('#selected-path', el => el.textContent), 'third.txt');
    assert.deepEqual(await page.evaluate(() => [...fileViews.keys()]), ['unstaged:draft-one.txt'], 'explicitly cancelled clean view is evicted, dirty first view retained');
    await page.evaluate(() => selectFile({ path: 'draft-one.txt', section: 'unstaged', status: 'M' }));
    assert.equal(await page.$eval('.comment-composer textarea', el => el.value), 'first unsaved body');
    await page.close(); fileViewLimit = 30;
  });
  await t.test('external disappearance preserves active and cached drafts with recovery and no cache lock', async (t) => {
    const other = { path: 'other.txt', section: 'unstaged', status: 'M' };
    for (const kind of ['clean', 'staged', 'removed']) await t.test(kind, async () => {
      fixtureFiles = { changes: [file, other], staged: [] }; comments = [];
      const page = await browser.newPage(); await page.setViewport({ width: 320, height: 800, isMobile: true, hasTouch: true });
      await page.goto(`${origin}/embed/w/fake/`); await page.waitForSelector('.file-row');
      await page.click('.file-row[data-file-key^="unstaged:"]'); await page.waitForSelector('.diff-row');
      await page.click('#line-selection-mode'); await page.click('.diff-row[data-line="1"]'); await page.click('#add-comment');
      await page.type('.comment-composer textarea', `retained ${kind} <img src=x>`);
      fixtureFiles = kind === 'clean' ? { changes: [], staged: [] }
        : { changes: [other], staged: kind === 'staged' ? [{ ...file, section: 'staged' }] : [] };
      revision++;
      await page.waitForSelector('.recover-draft');
      assert.equal(await page.evaluate(() => model.selected), null);
      assert.equal(await page.evaluate(() => [...fileViews.values()].some(view => view.commentComposer?.body?.includes('retained'))), true);
      if (kind === 'clean') {
        assert.match(await page.$eval('.empty-sidebar', el => el.textContent), /Working tree clean/);
        fixtureFiles = { changes: [other], staged: [] }; revision++;
        await page.waitForSelector('.file-row');
      }
      await page.click('.file-row[data-file-key="unstaged:other.txt"]'); await page.waitForSelector('.diff-row');
      await page.click('#back-to-files');
      await page.click('.recover-draft'); await page.waitForSelector('#recovered-draft');
      assert.equal(await page.$eval('#recovered-draft', el => el.value), `retained ${kind} <img src=x>`);
      assert.equal(await page.$eval('#recovered-draft', el => el.readOnly), true);
      assert.equal(await page.$eval('#modal-content', el => el.querySelectorAll('[data-comment-action="save"],img').length), 0);
      await page.click('#copy-recovered-draft');
      assert.equal(await page.$eval('#recovered-draft', el => el.value), `retained ${kind} <img src=x>`);
      if (kind === 'staged') {
        // If the old unstaged change reappears with the exact same patch, its
        // disappeared location still requires explicit reselection.
        await page.click('#close-modal');
        fixtureFiles = { changes: [file, other], staged: [] }; revision++;
        await page.waitForFunction(path => [...document.querySelectorAll('.file-row')].some(el => el.dataset.fileKey === `unstaged:${path}`), {}, file.path);
        await page.evaluate(path => [...document.querySelectorAll('.file-row')].find(el => el.dataset.fileKey === `unstaged:${path}`).click(), file.path);
        await page.waitForSelector('.draft-warning');
        assert.equal(await page.$eval('[data-comment-action="save"]', el => el.disabled), true);
        assert.equal(await page.$eval('.comment-composer textarea', el => el.value), `retained ${kind} <img src=x>`);
        await page.click('[data-comment-action="cancel"]');
      } else {
        await page.click('#discard-recovered-draft');
        assert.equal(await page.$('.recover-draft'), null);
        assert.equal(await page.evaluate(path => fileViews.has(`unstaged:${path}`), file.path), false);
      }
      await page.close();
    });
    await t.test('missing cached drafts stay recoverable when all cache slots are dirty', async () => {
      fileViewLimit = 2; fixtureFiles = { changes: [file, other], staged: [] };
      const page = await browser.newPage(); await page.setViewport({ width: 320, height: 800, isMobile: true, hasTouch: true });
      await page.goto(`${origin}/embed/w/fake/`); await page.waitForSelector('.file-row');
      for (const path of [file.path, other.path]) {
        await page.evaluate(path => [...document.querySelectorAll('.file-row')].find(el => el.dataset.fileKey === `unstaged:${path}`).click(), path);
        await page.waitForSelector('.diff-row');
        if (!await page.$eval('#line-selection-mode', el => el.checked)) await page.click('#line-selection-mode');
        await page.click('.diff-row[data-line="1"]'); await page.click('#add-comment'); await page.type('.comment-composer textarea', `draft for ${path}`);
        await page.click('#back-to-files');
      }
      const third = { path: 'new-file.txt', section: 'unstaged', status: 'M' };
      fixtureFiles = { changes: [third], staged: [] }; revision++;
      await page.waitForFunction(() => document.querySelectorAll('.recover-draft').length === 2);
      await page.click('.file-row');
      assert.match(await page.$eval('#toast', el => el.textContent), /Draft limit reached/);
      assert.equal(await page.$eval('.sidebar', el => getComputedStyle(el).display), 'grid', 'refused selection leaves recovery controls reachable');
      await page.click('.recover-draft'); await page.waitForSelector('#recovered-draft');
      assert.ok((await page.$eval('#recovered-draft', el => el.value)).startsWith('draft for '));
      await page.click('#discard-recovered-draft');
      await page.click('.file-row'); await page.waitForSelector('.diff-row');
      assert.equal(await page.$eval('#selected-path', el => el.textContent), 'new-file.txt', 'discarding an unavailable draft frees a cache slot');
      await page.click('#back-to-files'); await page.click('.recover-draft'); await page.waitForSelector('#recovered-draft');
      assert.ok((await page.$eval('#recovered-draft', el => el.value)).startsWith('draft for '));
      await page.click('#discard-recovered-draft');
      assert.equal(await page.$('.recover-draft'), null);
      await page.close(); fileViewLimit = 30;
    });
    fixtureFiles = null;
  });
  assert.ok(calls.every(c => Array.isArray(c.args)));
  const pureReads = new Set(['state', 'reviewState', 'diff', 'history', 'commitDetails', 'commitFileDiff', 'branches', 'remotes', 'worktrees', 'readTarget']);
  assert.ok(calls.filter(c => pureReads.has(c.method)).every(c => c.requestId === undefined), 'pure reads do not consume the backend result ledger');
  assert.ok(calls.filter(c => !pureReads.has(c.method)).every(c => /^[0-9a-f-]{36}$/.test(c.requestId)), 'mutations, confirm, and consuming uiRequests carry an opaque UUID');
});
