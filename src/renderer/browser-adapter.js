/* Browser-only transport. Electron's preload is authoritative. */
(() => {
  if (window.gittyGo) return;
  document.documentElement.classList.add('browser-host');
  const listeners = new Map();
  const emit = (name, value) => { for (const callback of listeners.get(name) || []) callback(value); };
  const subscribe = (name) => (callback) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return () => listeners.get(name).delete(callback);
  };
  const pureReads = new Set(['state', 'reviewState', 'diff', 'history', 'commitDetails', 'commitFileDiff', 'branches', 'remotes', 'worktrees', 'readTarget']);
  async function post(method, args) {
    // The browser network stack may replay a POST before response headers arrive.
    // Deduplicate mutations and consuming uiRequests, but keep pure reads out of
    // the service's bounded result ledger (especially potentially large diffs).
    const request = { method, args };
    if (!pureReads.has(method)) request.requestId = crypto.randomUUID();
    const body = JSON.stringify(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(new URL('rpc', location.href), {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body,
      });
      if (!response.ok) throw new Error(`Workspace request failed (${response.status}). Outcome unconfirmed; check current state before repeating.`);
      return await response.json();
    } catch (error) {
      return { ok: false, error: { message: `Connection interrupted. Outcome unconfirmed; check current state before repeating. ${error.message}` } };
    } finally { clearTimeout(timer); }
  }
  // Challenges are queued, never accepted automatically, including after reconnect.
  let confirmationQueue = Promise.resolve();
  function ask(challenge) {
    const pending = confirmationQueue.then(() => new Promise((resolve) => {
      const previous = document.activeElement;
      const dialog = document.createElement('dialog'); dialog.className = 'confirmation-dialog';
      const title = document.createElement('h2'); title.id = 'confirmation-title'; title.textContent = challenge.title || 'Confirm operation';
      const message = document.createElement('p'); message.id = 'confirmation-message'; message.textContent = challenge.message || '';
      const detail = document.createElement('pre'); detail.textContent = challenge.detail || '';
      const actions = document.createElement('div'); actions.className = 'confirmation-actions';
      dialog.setAttribute('aria-labelledby', title.id); dialog.setAttribute('aria-describedby', message.id);
      dialog.append(title, message, detail, actions);
      const finish = (choice) => { dialog.close(); dialog.remove(); previous?.focus(); resolve(choice); };
      (challenge.choices || ['Cancel']).forEach((label, index) => {
        const button = document.createElement('button'); button.textContent = label;
        button.addEventListener('click', () => finish(index), { once: true }); actions.append(button);
      });
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(0); });
      document.body.append(dialog); dialog.showModal(); actions.firstElementChild.focus();
    }));
    confirmationQueue = pending.catch(() => 0); return pending;
  }
  let target;
  async function invoke(method, args) {
    const scoped = target && !['state', 'reviewState', 'worktrees', 'selectWorktree', 'initializeRepository', 'uiRequests'].includes(method);
    let response = await post(scoped ? (pureReads.has(method) ? 'readTarget' : 'target') : method, scoped ? [target, method, args] : args);
    if (response.ok && ['state', 'selectWorktree'].includes(method)) target = response.result.repo;
    if (response.ok && response.confirmation) {
      const choice = await ask(response.confirmation);
      response = await post('confirm', [response.confirmation.id, choice]);
      if (response.confirmation) return { ok: false, error: { message: 'Unexpected repeated confirmation. Refresh and review the operation again.' } };
    }
    if (!['state', 'reviewState', 'uiRequests', 'diff', 'history', 'commitDetails', 'commitFileDiff', 'branches', 'remotes'].includes(method)) schedule(0);
    return response;
  }
  const api = {};
  const methods = 'worktrees selectWorktree createWorktree removeWorktree initializeRepository state reviewState addReviewComment editReviewComment resolveReviewComment diff stageFile unstageFile stageAll unstageAll discardFile stageHunk unstageHunk discardHunk stageSelected commit history commitDetails commitFileDiff remotes branches fetch pull push undoCommit addRemote removeRemote switchBranch createBranch uiRequests'.split(' ');
  for (const method of methods) api[method] = (...args) => invoke(method, args);
  for (const name of ['Changed', 'ReviewChanged', 'FocusComment', 'SetCommitMessage', 'Error']) api[`on${name}`] = subscribe(name);
  window.gittyGo = Object.freeze(api);
  let timer, polling = false, failures = 0, refreshPending = false;
  const hostId = window.parent !== window ? new URL(location.href).searchParams.get('hostId') : null;
  // Colors only: no CSS grammar capable of URLs, variables, declarations or code.
  const themeTokens = new Set('bg panel raised border soft text muted faint accent accent-soft green green-bg red red-bg yellow'.split(' '));
  function themeColor(value) {
    if (typeof value !== 'string' || value.length > 80) return false;
    if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return true;
    const match = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/.exec(value);
    return !!match && match.slice(2, 5).every(n => Number(n) <= 255) &&
      (match[1] === 'rgba') === (match[5] !== undefined) && CSS.supports('color', value);
  }
  function accentInk(root, scheme) {
    // Resolve alpha colors against the actual host background before choosing
    // the more legible label color. No host-specific CSS or extra token needed.
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return scheme === 'light' ? '#fff' : '#111318';
    const style = getComputedStyle(root);
    context.fillStyle = scheme === 'light' ? '#fff' : '#111318'; context.fillRect(0, 0, 1, 1);
    for (const name of ['--bg', '--accent']) { context.fillStyle = style.getPropertyValue(name).trim(); context.fillRect(0, 0, 1, 1); }
    const luminance = rgb => rgb.slice(0, 3).map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const bg = luminance(Array.from(context.getImageData(0, 0, 1, 1).data)), dark = luminance([17, 19, 24]);
    const darkContrast = (Math.max(bg, dark) + .05) / (Math.min(bg, dark) + .05);
    return darkContrast >= 1.05 / (bg + .05) ? '#111318' : '#fff';
  }
  function applyTheme(theme) {
    // Validate the entire replacement before touching the current theme.
    if (theme !== null && (!theme || typeof theme !== 'object' || Array.isArray(theme) ||
        Object.keys(theme).some(key => !['colorScheme', 'tokens'].includes(key)) ||
        !['dark', 'light'].includes(theme.colorScheme) || !theme.tokens ||
        typeof theme.tokens !== 'object' || Array.isArray(theme.tokens) ||
        Object.entries(theme.tokens).some(([key, value]) => !themeTokens.has(key) || !themeColor(value)))) return false;
    const root = document.documentElement;
    for (const token of themeTokens) root.style.removeProperty(`--${token}`);
    root.style.removeProperty('--accent-ink');
    if (theme === null) root.removeAttribute('data-host-color-scheme');
    else {
      root.setAttribute('data-host-color-scheme', theme.colorScheme);
      for (const [token, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${token}`, value);
      root.style.setProperty('--accent-ink', accentInk(root, theme.colorScheme));
    }
    return true;
  }
  // An opted-in embedded host starts paused until its parent states visibility.
  let hostVisible = !hostId;
  const visible = () => !document.hidden && hostVisible;
  window.addEventListener('message', (event) => {
    const state = event.data;
    if (!hostId || event.source !== window.parent || event.origin !== location.origin ||
        state?.version !== 1 || state.hostId !== hostId) return;
    if (state.type === 'gittygo:theme') {
      if (applyTheme(state.theme)) window.parent.postMessage({ type: 'gittygo:theme-applied', version: 1, hostId }, location.origin);
      return;
    }
    if (state.type !== 'gittygo:host-state' || typeof state.visible !== 'boolean') return;
    const waking = !hostVisible && state.visible;
    hostVisible = state.visible;
    if (!hostVisible) clearTimeout(timer);
    else if (waking) schedule(0);
  });
  const snapshots = new Map();
  function changed(key, value) { const json = JSON.stringify(value); if (snapshots.get(key) === json) return false; snapshots.set(key, json); return true; }
  function schedule(delay = 2000) {
    clearTimeout(timer);
    if (!visible()) return;
    if (polling && delay === 0) { refreshPending = true; return; }
    timer = setTimeout(poll, delay);
  }
  async function poll() {
    if (!visible() || polling) return;
    polling = true;
    try {
      for (const [method, event] of [['state', 'Changed'], ['reviewState', 'ReviewChanged'], ['uiRequests', null]]) {
        if (!visible()) break;
        const response = await post(method, []);
        if (!response.ok) throw new Error(response.error?.message || 'Workspace unavailable');
        if (event && changed(method, response.result)) emit(event, response.result);
        if (!event) {
          const requests = response.result || {};
          if (requests.focusRequest && changed('focusRequest', requests.focusRequest)) emit('FocusComment', requests.focusRequest.commentId);
          // Proposals are non-consuming and may be re-read by other windows.
          // Renderer dedup happens only AFTER checking the active worktree.
          if (requests.commitMessageRequest) emit('SetCommitMessage', requests.commitMessageRequest);
        }
      }
      failures = 0;
    } catch (error) { if (!failures) emit('Error', error); failures += 1; }
    finally {
      polling = false;
      const delay = refreshPending ? 0 : Math.min(15000, 2000 * (1 + failures));
      refreshPending = false; schedule(delay);
    }
  }
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (visible()) schedule(0); });
  window.addEventListener('online', () => schedule(0));
  window.addEventListener('pageshow', () => schedule(0));
  schedule(0);
})();
