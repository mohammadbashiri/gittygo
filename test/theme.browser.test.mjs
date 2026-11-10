// Real Chromium, disposable HTTP/RPC fixtures; no owner sessions or Git mutations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_MODULE || (() => { throw new Error('Set PUPPETEER_MODULE to the absolute Puppeteer ESM module path.'); })()));
const pause = () => new Promise(resolve => setTimeout(resolve, 60));

test('embedded color contract: trust boundary, atomic colors, defaults and stable editors', async t => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://fixture.test').pathname;
    if (pathname === '/host') { res.setHeader('Content-Type', 'text/html'); res.end('<iframe id="workspace" style="width:1200px;height:760px" src="/w/fake/?hostId=theme-fixture"></iframe><iframe id="sibling" src="about:blank"></iframe>'); return; }
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const call = JSON.parse(body); calls.push(call);
      const results = {
        state: { name: 'Theme fixture', branch: 'main', head: 'abcdef', repo: '/fixture', changes: [{ path: 'test.txt', section: 'unstaged', status: 'M' }], staged: [] },
        reviewState: { comments: [], openCommentCount: 0 }, uiRequests: {}, worktrees: [], branches: [],
        readTarget: { patch: '-old\n+new', hunks: [{ id: 0, header: '@@ -1 +1 @@', lines: ['-old', '+new'] }] },
      };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: results[call.method] ?? null })); return;
    }
    const file = pathname.split('/').pop() || 'index.html';
    if (!['index.html', 'styles.css', 'renderer.js', 'browser-adapter.js'].includes(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(new URL(`../src/renderer/${file}`, import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 850 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(`${origin}/host`);
  const frame = page.frames().find(f => f.url().includes('/w/fake/'));
  await frame.waitForSelector('#commit-message');
  await page.evaluate(()=>{window.themeAcknowledgements=[];addEventListener('message',event=>{if(event.source===document.querySelector('#workspace').contentWindow&&event.data?.type==='gittygo:theme-applied')window.themeAcknowledgements.push({...event.data,bg:getComputedStyle(document.querySelector('#workspace').contentDocument.documentElement).getPropertyValue('--bg').trim()});});});
  const send = async (theme, overrides = {}, mode = 'parent') => {
    await page.evaluate(({ theme, overrides, mode, origin }) => {
      const target = document.querySelector('#workspace').contentWindow;
      const message = { type: 'gittygo:theme', version: 1, hostId: 'theme-fixture', theme, ...overrides };
      if (mode === 'sibling') document.querySelector('#sibling').contentWindow.eval(`parent.document.querySelector('#workspace').contentWindow.postMessage(${JSON.stringify(message)}, ${JSON.stringify(origin)})`);
      else if (mode === 'origin') target.dispatchEvent(new MessageEvent('message', { data: message, source: window, origin: 'https://evil.example' }));
      else target.postMessage(message, origin);
    }, { theme, overrides, mode, origin }); await pause();
  };
  const style = () => frame.evaluate(() => ({ inline: document.documentElement.getAttribute('style'), scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), attr: document.documentElement.getAttribute('data-host-color-scheme') }));
  assert.equal((await style()).bg, '#111318');
  // Paused host: even valid theme changes must not wake polling or allocate RPC IDs.
  await pause(); const before = calls.length;
  const valid = { colorScheme: 'light', tokens: { bg: '#fefefe', text: 'rgb(12, 34, 56)', 'accent-soft': 'rgba(20,30,40,.25)' } };
  for (const overrides of [{ hostId: 'other' }, { version: 2 }, { type: 'other' }]) { await send(valid, overrides); assert.equal((await style()).attr, null); }
  for (const mode of ['sibling', 'origin']) { await send(valid, {}, mode); assert.equal((await style()).attr, null); }
  assert.equal(await page.evaluate(()=>themeAcknowledgements.length),0,'untrusted themes receive no readiness acknowledgement');
  await send(valid); assert.equal((await style()).bg, '#fefefe'); assert.equal((await style()).scheme, 'light');
  assert.deepEqual(await page.evaluate(()=>themeAcknowledgements),[{type:'gittygo:theme-applied',version:1,hostId:'theme-fixture',bg:'#fefefe'}],'readiness is sent only after the host palette is applied');
  const accepted = await style();
  for (const tokens of [
    { bg: '#000', unknown: '#fff' }, { '--bg': '#fff' }, { mono: '#fff' }, { bg: 'url(https://evil.example/x)' },
    { bg: 'expression(alert(1))' }, { bg: '#fff; color:red' }, { bg: 'var(--text)' }, { bg: 'red' },
    { bg: 'rgb(256,0,0)' }, { bg: 'rgba(1,2,3,2)' }, { bg: 123 }, { bg: null }, { constructor: '#fff' },
  ]) { await send({ colorScheme: 'dark', tokens }); assert.deepEqual(await style(), accepted); }
  for (const theme of [undefined, {}, [], { colorScheme: 'auto', tokens: {} }, { colorScheme: 'dark', tokens: {}, css: 'body{}' }]) { await send(theme); assert.deepEqual(await style(), accepted); }
  assert.equal(await page.evaluate(()=>themeAcknowledgements.length),1,'invalid replacements receive no readiness acknowledgement');
  await send({ colorScheme: 'dark', tokens: {} }); assert.equal((await style()).bg, '#111318'); assert.equal((await style()).scheme, 'dark');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  assert.equal((await style()).bg, '#111318', 'explicit dark beats light OS');
  await send({ colorScheme: 'light', tokens: {} }); assert.equal((await style()).bg, '#f7f8fa');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  assert.equal((await style()).bg, '#f7f8fa', 'explicit light beats dark OS');
  await send(null); assert.equal((await style()).attr, null); assert.equal((await style()).bg, '#111318');
  const primaryColors = () => frame.$eval('#initialize-repository', el => { const style = getComputedStyle(el); return { ink: style.color, fill: style.backgroundColor }; });
  for (const colorScheme of ['dark', 'light']) {
    await send({ colorScheme, tokens: { bg: '#090a0c', accent: '#8bd5c5' } });
    assert.deepEqual(await primaryColors(), { ink: 'rgb(17, 19, 24)', fill: 'rgb(139, 213, 197)' }, 'Light teal gets a dark label in either host scheme');
    await send({ colorScheme, tokens: { bg: '#090a0c', accent: '#174b9b' } });
    assert.deepEqual(await primaryColors(), { ink: 'rgb(255, 255, 255)', fill: 'rgb(23, 75, 155)' }, 'A dark accent keeps a light label');
  }
  await send({ colorScheme: 'dark', tokens: { bg: '#090a0c', accent: 'rgba(139,213,197,.1)' } });
  assert.equal((await primaryColors()).ink, 'rgb(255, 255, 255)', 'Transparent accents are composited against the host background');
  await send(null); assert.equal(await frame.$eval('html', el => el.style.getPropertyValue('--accent-ink')), '', 'Reset removes the derived host ink');
  assert.equal(calls.length, before, 'theme updates never poll or invoke any RPC');
  await page.evaluate(origin => document.querySelector('#workspace').contentWindow.postMessage({ type: 'gittygo:host-state', version: 1, hostId: 'theme-fixture', visible: true }, origin), origin);
  await frame.waitForSelector('.file-row');
  await frame.type('#commit-message', 'Keep commit draft');
  await frame.click('.file-row'); await frame.waitForSelector('.diff-row');
  await frame.click('.diff-row[data-line="1"]'); await frame.click('#add-comment');
  await frame.type('.comment-composer textarea', 'Keep review draft');
  await frame.evaluate(() => { const el = document.querySelector('.comment-composer textarea'); el.focus(); el.setSelectionRange(2, 8, 'backward'); });
  const editors = () => frame.evaluate(() => { const el = document.querySelector('.comment-composer textarea'); return { commit: document.querySelector('#commit-message').value, review: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, focus: document.activeElement === el, selected: document.querySelector('#selection-count').textContent }; });
  const drafts = await editors(); const mutationCalls = calls.filter(c => c.requestId).length;
  for (const [name, theme] of [['light', valid], ['dark', { colorScheme: 'dark', tokens: { accent: '#aabbcc' } }], ['default', null]]) {
    await send(theme); assert.deepEqual(await editors(), drafts);
    await page.screenshot({ path: `/tmp/gittygo-theme-${name}.png` });
  }
  assert.equal(calls.filter(c => c.requestId).length, mutationCalls, 'updates do not allocate mutation/consuming request IDs');
  // Standalone ignores even same-window theme messages; native preload exits first.
  const standalone = await browser.newPage(); await standalone.goto(`${origin}/w/fake/`);
  await standalone.evaluate(() => window.postMessage({ type: 'gittygo:theme', version: 1, hostId: 'theme-fixture', theme: { colorScheme: 'light', tokens: { bg: '#123456' } } }, location.origin));
  await pause(); assert.equal(await standalone.$eval('html', el => el.hasAttribute('data-host-color-scheme')), false);
  const native = await browser.newPage(); await native.evaluateOnNewDocument(() => { window.gittyGo = { nativeMarker: true }; });
  await native.goto(`${origin}/w/fake/?hostId=theme-fixture`);
  assert.equal(await native.evaluate(() => window.gittyGo.nativeMarker && !document.documentElement.classList.contains('browser-host')), true);
});
