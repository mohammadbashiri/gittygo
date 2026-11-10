const $ = (selector) => document.querySelector(selector);
const ui = {
  repoName: $('#repo-name'), branchName: $('#branch-name'), syncState: $('#sync-state'), updatedLabel: $('#updated-label'),
  groups: $('#file-groups'), commitMessage: $('#commit-message'), commitButton: $('#commit-button'), amend: $('#amend-checkbox'), toolbar: $('#file-toolbar'),
  selectedStatus: $('#selected-status'), selectedPath: $('#selected-path'), fileAction: $('#file-action'), discardFile: $('#discard-file'),
  content: $('#content'), toast: $('#toast'), historyList: $('#history-list'), historyDetail: $('#history-detail'), historyCount: $('#history-count'),
  moreMenu: $('#more-menu'), branchPopover: $('#branch-popover'), branchList: $('#branch-list'), modal: $('#modal-backdrop'), modalContent: $('#modal-content'),
  selectionAction: $('#selection-action'), selectionCount: $('#selection-count'), applySelection: $('#apply-selection'), addComment: $('#add-comment'),
};

const model = { repo: null, commitProposal: null, commitProposalSeen: null, selected: null, diff: null, layout: 'unified', busy: false, view: 'changes', history: [], selectedCommit: null, commitDetail: null, selectedCommitFile: null, commitFileDiff: null, selectedLines: null, selectionAnchor: null, selectionSide: null, review: { comments: [], openCommentCount: 0 }, commentComposer: null, diffRequestId: 0, diffLoadingKey: null, diffKey: null };
const initialModel = { ...model };
const worktreeViews = new Map();
let navigatingWorktree = false;
const storedPreference = (key) => localStorage.getItem(`gittygo:${key}`) ?? localStorage.getItem(`git-review:${key}`);
const sidebarState = {
  changes: {
    collapsed: storedPreference('sidebar:changes') === 'collapsed',
    width: Number(storedPreference('sidebar:changes:width')) || null,
  },
  history: {
    collapsed: storedPreference('sidebar:history') === 'collapsed',
    width: Number(storedPreference('sidebar:history:width')) || null,
  },
};
const escapeHtml = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const basename = (filePath) => filePath.split('/').pop();
const dirname = (filePath) => { const parts = filePath.split('/'); parts.pop(); return parts.length ? `${parts.join('/')}/` : ''; };
const fileKey = (file) => `${file.section}:${file.path}`;
const diffStateKey = (file, repo = model.repo) => JSON.stringify({
  file: fileKey(file), status: file.status, indexStatus: file.indexStatus, worktreeStatus: file.worktreeStatus,
  mtime: file.worktreeMtimeMs || 0, ctime: file.worktreeCtimeMs || 0, size: file.worktreeSize ?? null,
  missing: Boolean(file.worktreeMissing), indexMtime: repo?.indexMtimeMs || 0, indexSize: repo?.indexSize || 0,
});

function maxSidebarWidth() { return Math.max(220, window.innerWidth - 360); }
function displayedSidebarWidth(view) {
  const saved = sidebarState[view].width;
  return saved ? Math.min(saved, maxSidebarWidth()) : null;
}
function persistSidebarState(view) {
  const state = sidebarState[view];
  localStorage.setItem(`gittygo:sidebar:${view}`, state.collapsed ? 'collapsed' : 'expanded');
  if (state.width) localStorage.setItem(`gittygo:sidebar:${view}:width`, String(Math.round(state.width)));
}
function applySidebarState(view) {
  const container = $(`#${view}-view`); const button = container.querySelector('.sidebar-toggle'); const state = sidebarState[view];
  const width = displayedSidebarWidth(view);
  if (width) container.style.setProperty('--sidebar-width', `${width}px`); else container.style.removeProperty('--sidebar-width');
  container.classList.toggle('sidebar-collapsed', state.collapsed);
  button.textContent = state.collapsed ? '›' : '‹';
  button.title = state.collapsed ? 'Drag to resize or click to expand' : 'Drag to resize or click to collapse';
  button.setAttribute('aria-label', `${state.collapsed ? 'Expand' : 'Collapse'} ${view === 'changes' ? 'Changes' : 'History'} sidebar; drag to resize`);
  button.setAttribute('aria-expanded', String(!state.collapsed));
}

let sidebarDrag = null;
document.querySelectorAll('.sidebar-toggle').forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const view = button.dataset.sidebar; const container = $(`#${view}-view`);
    sidebarDrag = {
      button, view, container, startX: event.clientX,
      startWidth: sidebarState[view].collapsed ? 0 : container.querySelector('aside').getBoundingClientRect().width,
      moved: false, previewWidth: 0,
    };
    button.setPointerCapture(event.pointerId); document.body.classList.add('resizing-sidebar'); event.preventDefault();
  });
  button.addEventListener('pointermove', (event) => {
    if (!sidebarDrag || sidebarDrag.button !== button) return;
    const delta = event.clientX - sidebarDrag.startX;
    if (!sidebarDrag.moved && Math.abs(delta) < 4) return;
    sidebarDrag.moved = true;
    sidebarDrag.previewWidth = Math.max(0, Math.min(maxSidebarWidth(), sidebarDrag.startWidth + delta));
    sidebarDrag.container.classList.remove('sidebar-collapsed');
    sidebarDrag.container.style.setProperty('--sidebar-width', `${sidebarDrag.previewWidth}px`);
  });
  const finishDrag = (event) => {
    if (!sidebarDrag || sidebarDrag.button !== button) return;
    const { view, moved, previewWidth } = sidebarDrag; const state = sidebarState[view];
    if (moved) {
      if (previewWidth < 100) state.collapsed = true;
      else {
        state.collapsed = false;
        state.width = Math.max(view === 'history' ? 280 : 220, previewWidth);
      }
    } else state.collapsed = !state.collapsed;
    persistSidebarState(view); sidebarDrag = null; document.body.classList.remove('resizing-sidebar'); applySidebarState(view);
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
  };
  button.addEventListener('pointerup', finishDrag);
  button.addEventListener('pointercancel', () => {
    if (!sidebarDrag || sidebarDrag.button !== button) return;
    const view = sidebarDrag.view; sidebarDrag = null; document.body.classList.remove('resizing-sidebar'); applySidebarState(view);
  });
  button.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    const view = button.dataset.sidebar; sidebarState[view].collapsed = !sidebarState[view].collapsed;
    persistSidebarState(view); applySidebarState(view);
  });
});
window.addEventListener('resize', () => { applySidebarState('changes'); applySidebarState('history'); });
applySidebarState('changes'); applySidebarState('history');

function showToast(message, error = false) {
  ui.toast.textContent = message; ui.toast.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { ui.toast.className = 'toast'; }, 3400);
}
async function unwrap(promise, successMessage) {
  model.busy = true;
  try {
    const response = await promise;
    if (!response?.ok) { showToast(response?.error?.message || 'Operation failed', true); return null; }
    if (successMessage && !response.result?.cancelled) showToast(successMessage);
    return response.result;
  } catch (error) { showToast(error.message, true); return null; }
  finally { model.busy = false; }
}

function allReviewComments() { return model.review.comments || []; }
function reviewCommentsForFile(file) {
  return allReviewComments().filter((comment) => comment.anchor.path === file.path && comment.anchor.section === file.section);
}
function renderFiles() {
  const groups = [
    { title: 'Staged Changes', files: model.repo.staged, action: 'unstage', symbol: '−', actionLabel: 'Unstage all changes' },
    { title: 'Changes', files: model.repo.changes, action: 'stage', symbol: '+', actionLabel: 'Stage all changes' },
  ].filter((group) => group.files.length);
  const recovery = renderMissingDrafts();
  if (!groups.length) { ui.groups.innerHTML = `${recovery}<div class="empty-sidebar"><strong>Working tree clean</strong>There are no changes to review.</div>`; return; }
  ui.groups.innerHTML = recovery + groups.map((group) => `<section class="group"><header class="group-heading"><span>${group.title}</span><span class="group-heading-actions"><span class="count">${group.files.length}</span><button class="group-action" data-group-action="${group.action}" title="${group.actionLabel}" aria-label="${group.actionLabel}">${group.symbol}</button></span></header>${group.files.map((file) => `<button class="file-row ${file.conflicted ? 'conflicted' : ''} ${model.selected && fileKey(file) === fileKey(model.selected) ? 'selected' : ''}" data-file-key="${escapeHtml(fileKey(file))}" title="${file.conflicted ? 'Conflict: resolve outside GittyGo before staging' : escapeHtml(file.path)}"><span class="file-status ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span><span class="file-path" title="${escapeHtml(file.path)}"><span class="file-dir">${escapeHtml(dirname(file.path))}</span>${escapeHtml(basename(file.path))}</span><span class="row-action" title="${file.section === 'staged' ? 'Unstage' : 'Stage'}">${reviewCommentsForFile(file).filter((comment) => comment.status === 'open').length ? `<i class="comment-count">${reviewCommentsForFile(file).filter((comment) => comment.status === 'open').length}</i>` : ''}${file.section === 'staged' ? '−' : '+'}</span></button>`).join('')}</section>`).join('');
}

function renderMissingDrafts() {
  const available = new Set([...model.repo.changes, ...model.repo.staged].map(fileKey));
  const missing = [...fileViews].filter(([key, view]) => !available.has(key) && view.commentComposer?.body?.length);
  if (!missing.length) return '';
  return `<section class="missing-drafts"><h3>Unavailable comment drafts</h3><p>These changes are no longer listed. Draft text is kept for copying or explicit discard; it cannot be submitted at its old location.</p>${missing.map(([key, view]) => `<button class="recover-draft" data-draft-key="${escapeHtml(key)}"><strong>${escapeHtml(view.file.path)}</strong><span>${escapeHtml(view.file.section)} · Recover draft</span></button>`).join('')}</section>`;
}
function openMissingDraft(key) {
  const draft = fileViews.get(key)?.commentComposer;
  if (!draft?.body?.length) return;
  $('#modal-title').textContent = 'Recover unavailable comment draft';
  ui.modalContent.innerHTML = '<p>This change is no longer listed. Copy the saved text into a new comment after selecting a current diff location, or explicitly discard it. Nothing can be submitted from this recovery view.</p><label for="recovered-draft">Saved comment text</label><textarea id="recovered-draft" rows="8" readonly></textarea><div class="draft-recovery-actions"><button id="copy-recovered-draft" class="quiet-button">Copy draft</button><button id="discard-recovered-draft" class="danger-button">Discard saved draft</button></div>';
  const text = $('#recovered-draft'); text.value = draft.body;
  ui.modal.classList.remove('hidden'); text.focus(); text.select();
  $('#copy-recovered-draft').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(draft.body); showToast('Draft copied. Select a current diff location before posting a new comment.'); }
    catch { text.focus(); text.select(); showToast('Draft text selected. Use your browser’s Copy command to copy it.'); }
  });
  $('#discard-recovered-draft').addEventListener('click', () => { fileViews.delete(key); ui.modal.classList.add('hidden'); renderFiles(); });
}
ui.groups.addEventListener('click', (event) => {
  const button = event.target.closest('[data-draft-key]');
  if (button) openMissingDraft(button.dataset.draftKey);
});
ui.groups.addEventListener('click', async (event) => {
  const button = event.target.closest('.group-action'); if (!button || model.busy) return;
  if (button.dataset.groupAction === 'stage') await unwrap(window.gittyGo.stageAll(), 'All changes staged');
  else await unwrap(window.gittyGo.unstageAll(), 'All changes unstaged');
});
ui.groups.addEventListener('click', (event) => {
  if (event.button !== 0) return; const row = event.target.closest('.file-row'); if (!row || !model.repo) return;
  const file = [...model.repo.changes, ...model.repo.staged].find((item) => fileKey(item) === row.dataset.fileKey); if (!file) return;
  if (event.target.closest('.row-action')) toggleFileStage(file); else selectFile(file);
});
ui.groups.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return; const row = event.target.closest('.file-row'); if (!row) return;
  const file = [...model.repo.changes, ...model.repo.staged].find((item) => fileKey(item) === row.dataset.fileKey); if (file) { event.preventDefault(); selectFile(file); }
});

function renderRepo(state) {
  if (navigatingWorktree || (model.repo && model.repo.repo !== state.repo)) return;
  const blocked = !!(state.nonRepository || state.unavailable);
  $('#unavailable-worktree').classList.toggle('hidden', !state.unavailable);
  $('#non-repository').classList.toggle('hidden', !state.nonRepository);
  $('#changes-view').classList.toggle('hidden', blocked || model.view !== 'changes');
  $('#history-view').classList.toggle('hidden', blocked || model.view !== 'history');
  $('.view-tabs').classList.toggle('hidden', blocked);
  $('.repository-controls').classList.toggle('hidden', blocked);
  $('.repository-actions').classList.toggle('hidden', blocked);
  $('.app-shell').classList.toggle('non-repository-mode', blocked);
  const repositoryPath = state.repo || state.name;
  const pathText = document.createElement('span'); pathText.dir = 'ltr'; pathText.textContent = repositoryPath;
  const pathLabel = document.createElement('span'); pathLabel.className = 'path-label'; pathLabel.dir = 'rtl'; pathLabel.append(pathText);
  ui.repoName.replaceChildren(pathLabel); ui.repoName.title = repositoryPath;
  if (blocked) { model.repo = state; return; }
  const oldHead = model.repo?.head; model.repo = state;
  warmPickerMetadata(state);
  ui.branchName.textContent = state.branch;
  ui.syncState.textContent = state.upstream ? `${state.upstream}  ↑${state.ahead} ↓${state.behind}` : 'No upstream';
  ui.syncState.title = state.operation ? `${state.operation} in progress` : state.upstream || 'No upstream configured';
  updateCommitUi();
  if (model.selected) {
    const stillPresent = [...state.changes, ...state.staged].find((file) => fileKey(file) === fileKey(model.selected));
    if (stillPresent) {
      const nextDiffKey = diffStateKey(stillPresent, state); model.selected = stillPresent;
      if (nextDiffKey !== model.diffKey && nextDiffKey !== model.diffLoadingKey) loadDiff(false);
    } else {
      rememberFileView();
      if (model.commentComposer?.body?.length) showToast('The selected change is no longer listed. Your comment text is kept under Unavailable comment drafts.');
      $('#changes-view').classList.remove('mobile-detail'); model.selected = null; model.commentComposer = null; model.diff = null; model.diffKey = null; model.diffLoadingKey = null; model.diffRequestId += 1; clearLineSelection(); renderReview();
    }
  }
  const available = new Set([...state.changes, ...state.staged].map(fileKey));
  for (const [key, view] of fileViews) {
    if (!available.has(key) && view.commentComposer) {
      view.commentComposer.stale = true; view.commentComposer.missing = true;
      view.selectedLines = null; view.selectionAnchor = null; view.selectionSide = null;
    }
  }
  renderFiles(); if (!model.selected) renderReview();
  if (model.view === 'history' && oldHead !== state.head) loadHistory();
  ui.updatedLabel.textContent = state.conflicted ? 'Conflicts need attention' : 'Updated just now';
  clearTimeout(renderRepo.timer); renderRepo.timer = setTimeout(() => { ui.updatedLabel.textContent = state.operation ? `${state.operation} in progress` : 'Live'; }, 1400);
}

const FILE_VIEW_LIMIT = 30;
const fileViews = new Map();
function rememberFileView() {
  if (!model.selected) return;
  const editor = ui.content.querySelector('.comment-composer textarea');
  if (editor && model.commentComposer) model.commentComposer.body = editor.value;
  fileViews.set(fileKey(model.selected), { file: { ...model.selected }, selectedLines: model.selectedLines, selectionAnchor: model.selectionAnchor, selectionSide: model.selectionSide, commentComposer: model.commentComposer, top: ui.content.scrollTop, left: ui.content.scrollLeft, patch: model.diff?.patch });
}
function reserveFileView(file) {
  if (fileViews.has(fileKey(file)) || fileViews.size < FILE_VIEW_LIMIT) return true;
  const clean = [...fileViews].find(([, view]) => !view.commentComposer?.body?.length);
  if (clean) { fileViews.delete(clean[0]); return true; }
  showToast('Draft limit reached. Save or explicitly cancel a comment draft before opening another file. Your drafts were kept.', true);
  return false;
}
$('#back-to-files').addEventListener('click', () => { $('#changes-view').classList.remove('mobile-detail'); $('#selection-tools').classList.add('hidden'); ui.selectionAction.classList.add('hidden'); });
async function selectFile(file) {
  if (model.selected && fileKey(model.selected) === fileKey(file)) {
    $('#changes-view').classList.add('mobile-detail'); $('#selection-tools').classList.remove('hidden'); updateSelectionUi(); return;
  }
  rememberFileView();
  if (!reserveFileView(file)) return;
  $('#changes-view').classList.add('mobile-detail'); $('#selection-tools').classList.remove('hidden');
  model.commentComposer = null;
  model.selected = file; model.diff = null; model.diffKey = null; model.diffLoadingKey = null; model.diffRequestId += 1;
  clearLineSelection(); ui.content.scrollTop = 0; ui.content.scrollLeft = 0; renderFiles(); renderReview(); await loadDiff(true);
}
async function loadDiff(showLoading) {
  if (!model.selected) return;
  const requestedFileKey = fileKey(model.selected); const requestedStateKey = diffStateKey(model.selected);
  if (model.diffLoadingKey === requestedStateKey) return;
  const requestId = ++model.diffRequestId;
  model.diffLoadingKey = requestedStateKey;
  if (showLoading) ui.content.innerHTML = '<div class="empty-diff">Loading diff…</div>';
  const result = await unwrap(window.gittyGo.diff(model.selected.path, model.selected.section));
  if (requestId !== model.diffRequestId) return;
  model.diffLoadingKey = null;
  if (!result || !model.selected || requestedFileKey !== fileKey(model.selected) || requestedStateKey !== diffStateKey(model.selected)) return;
  if (model.diff && model.diff.patch !== result.patch) clearLineSelection();
  const saved = showLoading ? fileViews.get(requestedFileKey) : null;
  if (saved) {
    model.commentComposer = saved.commentComposer;
    if (saved.patch === result.patch) { model.selectedLines = saved.selectedLines; model.selectionAnchor = saved.selectionAnchor; model.selectionSide = saved.selectionSide; }
  }
  if (model.commentComposer && model.commentComposer.patch !== result.patch) model.commentComposer.stale = true;
  model.diff = result; model.diffKey = requestedStateKey; renderReview();
  if (saved) { ui.content.scrollTop = saved.top; ui.content.scrollLeft = saved.left; }
}
function renderReview() {
  const top = ui.content.scrollTop, left = ui.content.scrollLeft;
  const editor = ui.content.querySelector('.comment-composer textarea');
  const focused = editor && document.activeElement === editor;
  const selection = editor ? [editor.selectionStart, editor.selectionEnd] : null;
  if (editor && model.commentComposer) model.commentComposer.body = editor.value;
  renderReviewContent();
  ui.content.scrollTop = top; ui.content.scrollLeft = left;
  if (focused) { const replacement = ui.content.querySelector('.comment-composer textarea'); replacement?.focus({ preventScroll: true }); if (replacement) replacement.setSelectionRange(...selection); }
}
function renderReviewContent() {
  $('#selection-tools').classList.toggle('hidden', !model.selected || model.view !== 'changes' || !$('#changes-view').classList.contains('mobile-detail'));
  if (!model.selected) { ui.toolbar.classList.add('hidden'); ui.content.innerHTML = '<div class="welcome"><div><div class="welcome-mark">✓</div><h2>Select a changed file</h2><p>Review, stage, and commit without opening an editor.</p></div></div>'; return; }
  ui.toolbar.classList.remove('hidden'); ui.selectedStatus.textContent = model.selected.status; ui.selectedPath.textContent = model.selected.path;
  ui.fileAction.textContent = model.selected.conflicted ? 'Conflict' : model.selected.section === 'staged' ? 'Unstage file' : 'Stage file';
  ui.fileAction.disabled = Boolean(model.selected.conflicted); ui.discardFile.disabled = Boolean(model.selected.conflicted); ui.discardFile.classList.toggle('hidden', model.selected.section === 'staged');
  if (!model.diff) return;
  if (model.diff.binary || !model.diff.patch) {
    ui.content.innerHTML = `${model.commentComposer ? renderCommentComposer() : ''}<div class="empty-diff">${model.diff.binary ? 'Binary file changed. Diff preview is unavailable.' : 'No textual changes to display.'}</div>`;
    bindReviewEvents(); return;
  }
  ui.content.innerHTML = renderDiff(model.diff.patch, model.diff.hunks, model.selected.section, model.layout); bindHunkActions(); bindReviewEvents(); updateSelectionUi();
}
function parseHunkRange(header) { const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/); return match ? { old: Number(match[1]), next: Number(match[3]) } : { old: 0, next: 0 }; }
function splitPatch(patch) { const lines = patch.split('\n'); const first = lines.findIndex((line) => line.startsWith('@@ ')); return { header: first < 0 ? lines : lines.slice(0, first) }; }
function renderDiff(patch, hunks, section, layout, readOnly = false) {
  const usefulHeader = splitPatch(patch).header.filter((line) => line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ '));
  const unlocated = readOnly ? '' : renderUnlocatedComments(hunks);
  return `<div class="diff ${layout}${readOnly ? ' read-only' : ''}"><div class="file-header">${usefulHeader.map(escapeHtml).join('\n')}</div>${unlocated}${!readOnly && model.commentComposer?.stale ? renderCommentComposer() : ''}${hunks.map((hunk) => renderHunk(hunk, section, layout, readOnly)).join('')}</div>`;
}
function renderUnlocatedComments(hunks) {
  if (!model.selected) return '';
  const comments = reviewCommentsForFile(model.selected).filter((comment) => {
    const hunk = hunks.find((item) => item.header === comment.anchor.hunkHeader);
    return !hunk || comment.anchor.endIndex >= hunk.lines.length;
  });
  if (!comments.length) return '';
  return `<section class="unlocated-comments"><header><strong>Location changed</strong><span>${comments.length} ${comments.length === 1 ? 'comment no longer matches' : 'comments no longer match'} the current diff</span></header>${comments.map(renderReviewThread).join('')}</section>`;
}
function renderHunk(hunk, section, layout, readOnly = false) {
  const action = section === 'staged' ? 'Unstage hunk' : 'Stage hunk';
  const actions = readOnly ? '' : `<span class="hunk-actions"><button class="toggle-hunk">${action}</button>${section === 'unstaged' ? '<button class="discard-hunk">Discard</button>' : ''}</span>`;
  return `<section class="hunk" data-hunk="${escapeHtml(hunk.id)}"><header class="hunk-header"><span>${escapeHtml(hunk.header)}</span>${actions}</header>${layout === 'split' ? renderSplitLines(hunk, readOnly) : renderUnifiedLines(hunk, readOnly)}</section>`;
}
function renderUnifiedLines(hunk, readOnly = false) {
  const range = parseHunkRange(hunk.header); let oldLine = range.old; let newLine = range.next;
  const comments = readOnly || !model.selected ? [] : reviewCommentsForFile(model.selected).filter((comment) => comment.anchor.hunkHeader === hunk.header);
  return hunk.lines.map((line, index) => {
    if (line === '' && index === hunk.lines.length - 1) return '';
    const marker = line[0] || ' '; const metadata = marker === '\\'; const kind = marker === '+' ? 'add' : marker === '-' ? 'del' : 'context';
    const oldNumber = metadata || marker === '+' ? '' : oldLine++; const newNumber = metadata || marker === '-' ? '' : newLine++;
    const selectable = !readOnly && !metadata; const selected = model.selectedLines?.hunkId === hunk.id && model.selectedLines.indexes.has(index);
    const row = `<div class="diff-row ${kind}${selectable ? ' selectable' : ''}${selected ? ' line-selected' : ''}" ${selectable ? `data-hunk="${escapeHtml(hunk.id)}" data-line="${index}" title="Click to select; Shift-click to select a range"` : ''}><span class="line-no">${oldNumber}</span><span class="line-no">${newNumber}</span><span class="marker">${metadata ? '' : escapeHtml(marker)}</span><span class="code">${escapeHtml(metadata ? line : line.slice(1))}</span></div>`;
    const threads = comments.filter((comment) => comment.anchor.endIndex === index).map(renderReviewThread).join('');
    const composer = !readOnly && !model.commentComposer?.stale && model.commentComposer?.anchor?.hunkId === hunk.id && model.commentComposer.anchor.endIndex === index ? renderCommentComposer() : '';
    return `${row}${threads}${composer}`;
  }).join('');
}
function renderSplitLines(hunk, readOnly = false) {
  const range = parseHunkRange(hunk.header); let oldLine = range.old; let newLine = range.next; const rows = []; let removed = []; let added = [];
  const flush = () => { const length = Math.max(removed.length, added.length); for (let i = 0; i < length; i += 1) rows.push({ left: removed[i] || null, right: added[i] || null }); removed = []; added = []; };
  hunk.lines.forEach((line, index) => { if (line === '' && index === hunk.lines.length - 1) return; if (line.startsWith('-')) removed.push({ index, number: oldLine++, text: line.slice(1), kind: 'del', marker: '−' }); else if (line.startsWith('+')) added.push({ index, number: newLine++, text: line.slice(1), kind: 'add', marker: '+' }); else { flush(); const metadata = line.startsWith('\\'); const text = metadata ? line : line.slice(1); rows.push({ left: { index, number: metadata ? '' : oldLine++, text, kind: 'context', marker: '', metadata }, right: { index, number: metadata ? '' : newLine++, text, kind: 'context', marker: '', metadata } }); } }); flush();
  const comments = readOnly || !model.selected ? [] : reviewCommentsForFile(model.selected).filter((comment) => comment.anchor.hunkHeader === hunk.header);
  const cell = (value, side) => {
    if (!value) return '<div class="split-cell empty"></div>';
    const selectable = !readOnly && !value.metadata; const selected = model.selectedLines?.hunkId === hunk.id && model.selectedLines.indexes.has(value.index) && model.selectionSide === side;
    return `<div class="split-cell ${value.kind}${selectable ? ' selectable' : ''}${selected ? ' line-selected' : ''}" ${selectable ? `data-hunk="${escapeHtml(hunk.id)}" data-line="${value.index}" data-side="${side}" title="Click to select; Shift-click to select a range"` : ''}><span class="line-no">${value.number}</span><span class="marker">${value.marker}</span><span class="code">${escapeHtml(value.text)}</span></div>`;
  };
  return rows.map((row) => {
    const indexes = [row.left?.index, row.right?.index].filter((value) => value != null);
    const threads = comments.filter((comment) => indexes.includes(comment.anchor.endIndex)).map(renderReviewThread).join('');
    const composer = !readOnly && !model.commentComposer?.stale && model.commentComposer?.anchor?.hunkId === hunk.id && indexes.includes(model.commentComposer.anchor.endIndex) ? renderCommentComposer() : '';
    return `<div class="split-row">${cell(row.left, 'old')}${cell(row.right, 'new')}</div>${threads}${composer}`;
  }).join('');
}
function bindHunkActions() {
  ui.content.querySelectorAll('.hunk').forEach((element) => { const hunk = model.diff.hunks[Number(element.dataset.hunk)];
    element.querySelector('.toggle-hunk').addEventListener('click', async () => { const staged = model.selected.section === 'staged'; await unwrap(staged ? window.gittyGo.unstageHunk(hunk.patch, model.selected.path) : window.gittyGo.stageHunk(hunk.patch, model.selected.path), staged ? 'Hunk unstaged' : 'Hunk staged'); });
    element.querySelector('.discard-hunk')?.addEventListener('click', () => unwrap(window.gittyGo.discardHunk(hunk.patch, model.selected.path), 'Hunk discarded'));
  });
}

ui.content.addEventListener('pointerdown', (event) => {
  // Shift-click is an explicit desktop range command; never cancel touch gestures.
  if (event.pointerType === 'mouse' && event.shiftKey && event.target.closest('.selectable')) event.preventDefault();
});
ui.content.addEventListener('click', (event) => {
  const row = event.target.closest('.diff-row.selectable, .split-cell.selectable'); if (!row) return;
  // Touch scrolling, pinch zoom and native text selection remain browser-owned.
  if (matchMedia('(pointer: coarse)').matches && !$('#line-selection-mode').checked) return;
  if (window.getSelection()?.toString()) return;
  const hunkId = Number(row.dataset.hunk); const line = Number(row.dataset.line); const side = row.dataset.side || 'both'; const hunk = model.diff.hunks[hunkId];
  if (!model.selectedLines || model.selectedLines.hunkId !== hunkId || model.selectionSide !== side) { model.selectedLines = { hunkId, indexes: new Set() }; model.selectionSide = side; }
  if ((event.shiftKey || $('#line-range-mode').checked) && model.selectionAnchor?.hunkId === hunkId && model.selectionAnchor.side === side) {
    const [start, end] = [model.selectionAnchor.line, line].sort((a, b) => a - b);
    hunk.lines.forEach((text, index) => { if (index >= start && index <= end && !text.startsWith('\\')) model.selectedLines.indexes.add(index); });
  } else {
    if (model.selectedLines.indexes.has(line)) model.selectedLines.indexes.delete(line); else model.selectedLines.indexes.add(line);
    model.selectionAnchor = { hunkId, line, side };
  }
  renderReview();
});
function clearLineSelection() { model.selectedLines = null; model.selectionAnchor = null; model.selectionSide = null; ui.selectionAction.classList.add('hidden'); }
function selectedChangedLineCount() {
  if (!model.selectedLines) return 0;
  const hunk = model.diff.hunks[model.selectedLines.hunkId];
  return [...model.selectedLines.indexes].filter((index) => ['+', '-'].includes(hunk.lines[index]?.[0])).length;
}
function updateSelectionUi() {
  const count = model.selectedLines?.indexes.size || 0; ui.selectionAction.classList.toggle('hidden', count === 0); if (!count) return;
  ui.selectionCount.textContent = `${count} ${count === 1 ? 'line' : 'lines'} selected`;
  const changedCount = selectedChangedLineCount();
  ui.applySelection.classList.toggle('hidden', changedCount === 0);
  ui.applySelection.textContent = model.selected.section === 'staged' ? 'Unstage selected' : 'Stage selected';
}
ui.applySelection.addEventListener('click', async () => {
  if (!model.selectedLines?.indexes.size || !selectedChangedLineCount()) return; const hunk = model.diff.hunks[model.selectedLines.hunkId];
  const result = await unwrap(window.gittyGo.stageSelected(hunk.patch, [...model.selectedLines.indexes], model.selected.section, model.selected.path), model.selected.section === 'staged' ? 'Selected lines unstaged' : 'Selected lines staged');
  if (result !== null) clearLineSelection();
});
ui.addComment.addEventListener('click', () => {
  if (!model.selectedLines?.indexes.size) return;
  if (model.commentComposer) return showToast('Save, cancel, or reselect the existing comment draft first.', true);
  model.commentComposer = { anchor: buildCommentAnchor(), body: '', patch: model.diff.patch }; renderReview();
  requestAnimationFrame(() => ui.content.querySelector('.comment-composer textarea')?.focus());
});
$('#clear-selection').addEventListener('click', () => { clearLineSelection(); renderReview(); });

function buildCommentAnchor() {
  const hunk = model.diff.hunks[model.selectedLines.hunkId]; const selected = [...model.selectedLines.indexes].sort((a, b) => a - b);
  const range = parseHunkRange(hunk.header); let oldLine = range.old; let newLine = range.next; const positions = [];
  hunk.lines.forEach((line, index) => {
    const marker = line[0] || ' '; const position = { index, marker, oldLine: marker === '+' || marker === '\\' ? null : oldLine, newLine: marker === '-' || marker === '\\' ? null : newLine };
    if (marker !== '+' && marker !== '\\') oldLine += 1;
    if (marker !== '-' && marker !== '\\') newLine += 1;
    if (selected.includes(index)) positions.push(position);
  });
  const markers = new Set(positions.map((item) => item.marker));
  const side = markers.size === 1 && markers.has('-') ? 'old' : markers.size === 1 && markers.has('+') ? 'new' : model.selectionSide === 'old' || model.selectionSide === 'new' ? model.selectionSide : 'both';
  const oldLines = positions.map((item) => item.oldLine).filter((value) => value != null); const newLines = positions.map((item) => item.newLine).filter((value) => value != null);
  const lineValues = side === 'old' ? oldLines : newLines;
  const bounds = (values) => values.length ? [Math.min(...values), Math.max(...values)] : [null, null];
  const [startLine, endLine] = bounds(lineValues); const [oldStartLine, oldEndLine] = bounds(oldLines); const [newStartLine, newEndLine] = bounds(newLines);
  return {
    path: model.selected.path, section: model.selected.section, side,
    startLine, endLine, oldStartLine, oldEndLine, newStartLine, newEndLine,
    hunkId: hunk.id, hunkHeader: hunk.header, startIndex: selected[0], endIndex: selected.at(-1),
    selectedText: selected.map((index) => hunk.lines[index].startsWith('\\') ? hunk.lines[index] : hunk.lines[index].slice(1)),
  };
}
function shortCommentId(id) { return id.slice(-6); }
function renderReviewThread(comment) {
  return `<article class="review-thread" data-comment-id="${escapeHtml(comment.id)}"><header><strong>Comment ${escapeHtml(shortCommentId(comment.id))}</strong><span>Open</span></header><p>${escapeHtml(comment.body)}</p><footer><button data-review-action="edit">Edit</button><button data-review-action="resolve">Resolve</button></footer></article>`;
}
function renderCommentComposer() {
  const stale = model.commentComposer?.stale;
  const warning = stale ? '<p class="draft-warning" role="alert">The diff changed. Your draft was kept, but its location is no longer verified. Select lines in the current diff, then use “Use selected lines” to create a new comment. It cannot be submitted at the old location.</p>' : '';
  return `<div class="comment-composer">${warning}<textarea rows="3" placeholder="Leave a review comment…">${escapeHtml(model.commentComposer?.body || '')}</textarea><div><button data-comment-action="cancel">Cancel</button>${stale ? `<button data-comment-action="reanchor" ${model.selectedLines?.indexes.size ? '' : 'disabled'}>Use selected lines</button>` : ''}<button data-comment-action="save" class="primary-comment" ${stale ? 'disabled' : ''}>${model.commentComposer?.commentId ? 'Save comment' : 'Add to review'}</button></div></div>`;
}
function bindReviewEvents() {
  const composer = ui.content.querySelector('.comment-composer');
  if (composer) {
    composer.querySelector('textarea').addEventListener('input', (event) => { if (model.commentComposer) model.commentComposer.body = event.target.value; });
    composer.querySelector('[data-comment-action="cancel"]').addEventListener('click', () => { model.commentComposer = null; renderReview(); });
    composer.querySelector('[data-comment-action="reanchor"]')?.addEventListener('click', () => {
      if (!model.selectedLines?.indexes.size) return;
      model.commentComposer = { anchor: buildCommentAnchor(), body: model.commentComposer.body, patch: model.diff.patch };
      renderReview();
    });
    composer.querySelector('[data-comment-action="save"]').addEventListener('click', async () => {
      if (model.commentComposer?.stale) return showToast('The diff changed. Select a new location before submitting this draft.', true);
      const body = composer.querySelector('textarea').value.trim(); if (!body) return showToast('Write a comment first.', true);
      const editing = model.commentComposer.commentId;
      const result = await unwrap(editing ? window.gittyGo.editReviewComment(editing, body) : window.gittyGo.addReviewComment(model.commentComposer.anchor, body));
      if (!result) return;
      model.review = { comments: result.comments, openCommentCount: result.openCommentCount };
      model.commentComposer = null; clearLineSelection(); renderFiles(); renderReview();
    });
  }
  ui.content.querySelectorAll('[data-review-action]').forEach((button) => button.addEventListener('click', async () => {
    const thread = button.closest('.review-thread'); const commentId = thread.dataset.commentId; const action = button.dataset.reviewAction;
    if (action === 'edit') {
      const comment = allReviewComments().find((item) => item.id === commentId);
      model.commentComposer = { anchor: comment.anchor, commentId, body: comment.body, patch: model.diff.patch }; renderReview(); return;
    }
    const result = await unwrap(window.gittyGo.resolveReviewComment(commentId));
    if (result) model.review = { comments: result.comments, openCommentCount: result.openCommentCount };
    renderFiles(); renderReview();
  }));
}

async function toggleFileStage(file = model.selected) { if (!file || model.busy) return; await unwrap(file.section === 'staged' ? window.gittyGo.unstageFile(file.path) : window.gittyGo.stageFile(file.path), file.section === 'staged' ? 'File unstaged' : 'File staged'); }
ui.fileAction.addEventListener('click', () => toggleFileStage());
ui.discardFile.addEventListener('click', () => model.selected && unwrap(window.gittyGo.discardFile(model.selected.path), 'Changes discarded'));
function validProposal(proposal) {
  return proposal?.version===1 && typeof proposal.proposalId==='string' && typeof proposal.message==='string' && proposal.message.length<=20000 && Number.isFinite(Date.parse(proposal.expiresAt)) && Date.parse(proposal.expiresAt)>=Date.now() && proposal.worktreeRoot===model.repo?.repo && proposal.baseHead===(model.repo?.head||null) && proposal.baseBranch===(model.repo?.branch||null);
}
function renderCommitProposal() {
  const node=$('#commit-proposal'); if(!node)return;
  if(!validProposal(model.commitProposal)){model.commitProposal=null;node.hidden=true;return;}
  node.hidden=!model.commitProposal.message||ui.commitMessage.value===model.commitProposal.message;
  $('#commit-proposal-text').textContent=model.commitProposal.message;
  $('#use-commit-proposal').textContent=ui.commitMessage.value.trim()?'Replace draft with suggestion':'Use suggestion';
}
$('#use-commit-proposal')?.addEventListener('click',()=>{
  const proposal=model.commitProposal;if(navigatingWorktree||!validProposal(proposal))return;
  if(ui.commitMessage.value.trim()&&!window.confirm('Replace your existing commit-message draft with this suggestion?'))return;
  ui.commitMessage.value=proposal.message;updateCommitUi();ui.commitMessage.focus();ui.commitMessage.setSelectionRange(proposal.message.length,proposal.message.length);
});
function updateCommitUi() {
  renderCommitProposal();
  const staged = model.repo?.staged.length || 0; const amend = ui.amend.checked; const hasMessage = Boolean(ui.commitMessage.value.trim());
  ui.commitButton.disabled = amend ? !staged && !hasMessage : !staged || !hasMessage;
  ui.commitButton.textContent = amend ? 'Amend last commit' : staged ? `Commit ${staged} ${staged === 1 ? 'file' : 'files'}` : 'Commit';
  ui.commitMessage.placeholder = amend ? 'Leave empty to keep the existing message…' : 'Describe the staged changes…';
}
ui.commitMessage.addEventListener('input', updateCommitUi); ui.amend.addEventListener('change', updateCommitUi);
ui.commitMessage.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') ui.commitButton.click(); });
ui.commitButton.addEventListener('click', async () => { if (ui.commitButton.disabled || model.busy) return; const wasAmend = ui.amend.checked; const hash = await unwrap(window.gittyGo.commit(ui.commitMessage.value, wasAmend)); if (typeof hash === 'string') { model.commitProposal=null; ui.commitMessage.value = ''; ui.amend.checked = false; updateCommitUi(); showToast(`${wasAmend ? 'Amended' : 'Committed'} as ${hash}`); } });
document.querySelectorAll('[data-layout]').forEach((button) => button.addEventListener('click', () => { model.layout = button.dataset.layout; clearLineSelection(); document.querySelectorAll('[data-layout]').forEach((item) => item.classList.toggle('active', item === button)); renderReview(); }));

async function setView(view) {
  model.view = view; document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#changes-view').classList.toggle('hidden', view !== 'changes'); $('#history-view').classList.toggle('hidden', view !== 'history');
  $('#selection-tools').classList.toggle('hidden', view !== 'changes' || !model.selected || !$('#changes-view').classList.contains('mobile-detail'));
  ui.selectionAction.classList.toggle('hidden', view !== 'changes' || !model.selectedLines?.indexes.size);
  if (view === 'history' && (!model.history.length || model.historyHead !== model.repo?.head)) await loadHistory();
}
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
let historyRequestId = 0;
async function loadHistory() {
  const requestId = ++historyRequestId;
  const root = model.repo?.repo, head = model.repo?.head;
  const top = ui.historyList.scrollTop;
  if (model.historyHead !== head) {
    // A checkout must not leave another branch's rows/details visible while
    // loading. Clearing selection also fences outstanding commit-detail reads.
    model.history = []; model.selectedCommit = null; model.commitDetail = null; model.selectedCommitFile = null; model.commitFileDiff = null;
    ui.historyCount.textContent = '';
    ui.historyDetail.innerHTML = '<div class="empty-diff">Select a commit to inspect its changes.</div>';
    $('#history-view').classList.remove('mobile-detail', 'mobile-file');
  }
  if (!model.history.length) ui.historyList.innerHTML = '<div class="empty-diff">Loading history…</div>';
  const history = await unwrap(window.gittyGo.history(200));
  if (!history || requestId !== historyRequestId || navigatingWorktree || root !== model.repo?.repo || head !== model.repo?.head) return;
  model.historyHead = head;
  model.history = layoutHistory(history); ui.historyCount.textContent = `${history.length} commits`;
  ui.historyList.innerHTML = history.length ? model.history.map((commit) => {
    const width = Math.max(1, commit.laneCount) * 16 + 12;
    const lines = Array.from({ length: commit.laneCount }, (_, lane) => `<i class="graph-line" style="left:${lane * 16 + 8}px"></i>`).join('');
    return `<button class="commit-row ${model.selectedCommit === commit.hash ? 'selected' : ''}" style="--graph-width:${width}px" data-commit="${commit.hash}"><span class="graph-cell">${lines}<i class="graph-dot" style="left:${commit.lane * 16 + 8}px"></i></span><span class="commit-main"><span class="commit-subject">${escapeHtml(commit.subject)}</span><span class="commit-meta"><span>${escapeHtml(commit.author)}</span><span>${formatRelativeDate(commit.date)}</span></span>${commit.refs.length ? `<span class="ref-badges">${commit.refs.map((ref) => `<i class="ref-badge">${escapeHtml(ref.replace(/^HEAD -> /, ''))}</i>`).join('')}</span>` : ''}</span><span class="commit-hash">${commit.shortHash}</span></button>`;
  }).join('') : '<div class="empty-sidebar">No commits yet.</div>';
  ui.historyList.scrollTop = top;
}
function layoutHistory(commits) {
  let lanes = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) { lane = lanes.length; lanes.push(commit.hash); }
    const beforeCount = lanes.length;
    if (commit.parents.length) {
      lanes[lane] = commit.parents[0];
      commit.parents.slice(1).forEach((parent, offset) => { if (!lanes.includes(parent)) lanes.splice(lane + 1 + offset, 0, parent); });
    } else lanes.splice(lane, 1);
    lanes = lanes.filter((hash, index) => lanes.indexOf(hash) === index);
    return { ...commit, lane, laneCount: Math.max(beforeCount, lanes.length, lane + 1) };
  });
}
function formatRelativeDate(value) { const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000); if (days <= 0) return 'today'; if (days === 1) return 'yesterday'; if (days < 30) return `${days} days ago`; return new Date(value).toLocaleDateString(); }
$('#history-back').addEventListener('click', () => {
  const view = $('#history-view');
  if (view.classList.contains('mobile-file')) { view.classList.remove('mobile-file'); $('#history-back').textContent = '‹ History'; }
  else view.classList.remove('mobile-detail');
});
ui.historyList.addEventListener('click', async (event) => {
  const row = event.target.closest('.commit-row'); if (!row) return;
  $('#history-view').classList.add('mobile-detail'); $('#history-view').classList.remove('mobile-file'); $('#history-back').textContent = '‹ History';
  if (model.selectedCommit === row.dataset.commit && model.commitDetail) return;
  model.selectedCommit = row.dataset.commit; model.commitDetail = null; model.selectedCommitFile = null; model.commitFileDiff = null;
  ui.historyList.querySelectorAll('.commit-row').forEach((item) => item.classList.toggle('selected', item === row));
  ui.historyDetail.innerHTML = '<div class="empty-diff">Loading commit…</div>';
  const root = model.repo?.repo;
  const detail = await unwrap(window.gittyGo.commitDetails(model.selectedCommit));
  if (!detail || navigatingWorktree || model.repo?.repo !== root || model.selectedCommit !== row.dataset.commit) return;
  model.commitDetail = detail; model.selectedCommitFile = detail.files[0] || null; renderCommitDetail();
  if (model.selectedCommitFile) await loadCommitFileDiff(model.selectedCommitFile);
});

function comparisonLabel(commit) {
  if (commit.comparison.kind === 'root') return 'Initial commit · compared with empty tree';
  if (commit.comparison.kind === 'first-parent') return `Merge commit · compared with first parent ${commit.comparison.base.slice(0, 7)}`;
  return `Compared with parent ${commit.comparison.base.slice(0, 7)}`;
}

function fileDisplayPath(file) {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

function renderCommitDetail() {
  const commit = model.commitDetail; if (!commit) return;
  const subject = commit.message.split('\n')[0]; const body = commit.message.split('\n').slice(1).join('\n').trim();
  ui.historyDetail.innerHTML = `<article class="commit-detail"><header class="commit-detail-header"><h2>${escapeHtml(subject)}</h2><div class="commit-detail-meta"><span>${escapeHtml(commit.author)} &lt;${escapeHtml(commit.email)}&gt;</span><span>${new Date(commit.date).toLocaleString()}</span><span title="${commit.hash}">${commit.shortHash}</span></div>${body ? `<p>${escapeHtml(body)}</p>` : ''}<div class="comparison-label">${escapeHtml(comparisonLabel(commit))}</div><div class="commit-totals"><strong>${commit.totals.files}</strong> ${commit.totals.files === 1 ? 'file' : 'files'} changed <span class="stat-add">+${commit.totals.additions}</span> <span class="stat-del">−${commit.totals.deletions}</span>${commit.totals.binaries ? ` · ${commit.totals.binaries} binary` : ''}</div></header><div class="commit-browser"><aside class="commit-files">${commit.files.map((file, index) => `<button class="commit-file-row ${model.selectedCommitFile === file ? 'selected' : ''}" data-file-index="${index}"><span class="file-status ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span><span class="commit-file-path" title="${escapeHtml(fileDisplayPath(file))}">${escapeHtml(fileDisplayPath(file))}</span><span class="file-stats">${file.binary ? 'Binary' : `<i class="stat-add">+${file.additions || 0}</i> <i class="stat-del">−${file.deletions || 0}</i>`}</span></button>`).join('') || '<div class="empty-sidebar">No file changes.</div>'}</aside><section class="commit-file-view"><header class="commit-file-toolbar">${model.selectedCommitFile ? `<strong>${escapeHtml(fileDisplayPath(model.selectedCommitFile))}</strong><div class="segmented"><button data-history-layout="unified" class="${model.layout === 'unified' ? 'active' : ''}">Unified</button><button data-history-layout="split" class="${model.layout === 'split' ? 'active' : ''}">Side by side</button></div>` : ''}</header><div id="commit-file-content" class="commit-file-content">${renderCommitFileContent()}</div></section></div></article>`;
  bindCommitDetailEvents();
}

function renderCommitFileContent() {
  if (!model.selectedCommitFile) return '<div class="empty-diff">No file selected.</div>';
  if (!model.commitFileDiff) return '<div class="empty-diff">Loading file diff…</div>';
  if (model.commitFileDiff.binary) return '<div class="empty-diff">Binary file changed. Textual diff is unavailable.</div>';
  if (!model.commitFileDiff.patch) return '<div class="empty-diff">This change has no textual patch.</div>';
  const warning = model.commitFileDiff.truncated ? '<div class="diff-warning">Diff is large and has been truncated.</div>' : '';
  return `${warning}${renderDiff(model.commitFileDiff.patch, model.commitFileDiff.hunks, 'history', model.layout, true)}`;
}

function bindCommitDetailEvents() {
  ui.historyDetail.querySelectorAll('.commit-file-row').forEach((row) => row.addEventListener('click', async () => {
    const file = model.commitDetail.files[Number(row.dataset.fileIndex)];
    if (!file) return;
    $('#history-view').classList.add('mobile-file'); $('#history-back').textContent = '‹ Commit files';
    if (file === model.selectedCommitFile) return;
    model.selectedCommitFile = file; model.commitFileDiff = null; renderCommitDetail(); await loadCommitFileDiff(file);
  }));
  ui.historyDetail.querySelectorAll('[data-history-layout]').forEach((button) => button.addEventListener('click', () => {
    model.layout = button.dataset.historyLayout; renderCommitDetail();
  }));
}

async function loadCommitFileDiff(file) {
  const root = model.repo?.repo;
  const commitHash = model.selectedCommit; const requestedPath = file.path;
  const result = await unwrap(window.gittyGo.commitFileDiff(commitHash, file.oldPath, file.path));
  if (!result || navigatingWorktree || model.repo?.repo !== root || model.selectedCommit !== commitHash || model.selectedCommitFile?.path !== requestedPath) return;
  model.commitFileDiff = result; renderCommitDetail();
}

async function viewWorktree(root) {
  if (navigatingWorktree || model.busy || root === model.repo?.repo) return;
  if (!worktreeViews.has(root) && worktreeViews.size >= 15) return showToast('Worktree view limit reached. Copy drafts and reopen before viewing more; nothing was discarded.', true);
  rememberFileView();
  const previous = model.repo?.repo;
  navigatingWorktree = true;
  const response = await window.gittyGo.selectWorktree(root);
  if (!response.ok) { navigatingWorktree = false; showToast(response.error.message, true); return; }
  if (previous) worktreeViews.set(previous, { model: { ...model }, files: new Map(fileViews), message: ui.commitMessage.value, messageSelection: [ui.commitMessage.selectionStart, ui.commitMessage.selectionEnd], amend: ui.amend.checked, groupsTop: ui.groups.scrollTop, historyCount: ui.historyCount.textContent, content: [...ui.content.childNodes], history: [...ui.historyDetail.childNodes], historyList: [...ui.historyList.childNodes], top: ui.content.scrollTop, left: ui.content.scrollLeft, historyTop: ui.historyList.scrollTop, detailTop: ui.historyDetail.scrollTop, changesClass: $('#changes-view').className, historyClass: $('#history-view').className });
  const saved = worktreeViews.get(root);
  const nextRequestId = model.diffRequestId + 1;
  // Detach before rendering so the old editor cannot overwrite the restored draft.
  ui.content.replaceChildren(); ui.historyDetail.replaceChildren(); ui.historyList.replaceChildren();
  Object.assign(model, saved?.model || { ...initialModel, review: { comments: [], openCommentCount: 0 }, history: [] });
  model.repo = null; model.busy = false; model.diffRequestId = nextRequestId; model.diffLoadingKey = null;
  fileViews.clear(); for (const [key, value] of saved?.files || []) fileViews.set(key, value);
  ui.commitMessage.value = saved?.message || ''; ui.amend.checked = saved?.amend || false;
  ui.historyCount.textContent = saved?.historyCount || '';
  if (saved?.messageSelection) ui.commitMessage.setSelectionRange(...saved.messageSelection);
  if (saved) { ui.content.replaceChildren(...saved.content); ui.historyDetail.replaceChildren(...saved.history); ui.historyList.replaceChildren(...saved.historyList); $('#changes-view').className = saved.changesClass; $('#history-view').className = saved.historyClass; }
  else { $('#changes-view').classList.remove('mobile-detail'); $('#history-view').classList.remove('mobile-detail', 'mobile-file'); }
  navigatingWorktree = false;
  renderRepo(response.result);
  const review = await unwrap(window.gittyGo.reviewState()); if (review) model.review = review;
  renderFiles(); renderReview(); await setView(model.view);
  if (model.commitDetail) renderCommitDetail();
  if (saved) { ui.content.scrollTop = saved.top; ui.content.scrollLeft = saved.left; ui.groups.scrollTop = saved.groupsTop; ui.historyList.scrollTop = saved.historyTop; ui.historyDetail.scrollTop = saved.detailTop; }
  ui.modal.classList.add('hidden'); closePopovers();
  showToast(`Viewing ${root}. No branch checkout was performed.`);
}
// Read-only snapshots, isolated by selected folder; never evict drafts or touch mutation IDs.
const pickerMetadata = new Map();
function pickerSnapshot(kind, root) {
  let folder=pickerMetadata.get(root);
  if(!folder){folder={};pickerMetadata.set(root,folder);while(pickerMetadata.size>16)pickerMetadata.delete(pickerMetadata.keys().next().value);}
  return folder[kind] ||= {value:null,pending:null,attempt:0};
}
function fetchPickerMetadata(kind, root) {
  const snapshot=pickerSnapshot(kind,root);
  if(snapshot.pending)return snapshot.pending;
  if(root!==model.repo?.repo||navigatingWorktree)return Promise.resolve(null);
  snapshot.attempt=Date.now();
  let request;try{request=window.gittyGo[kind]();}catch(error){request=Promise.reject(error);}
  snapshot.pending=Promise.resolve(request).then(response=>{
    if(!response?.ok||!Array.isArray(response.result))return null;
    snapshot.value=response.result;return snapshot.value;
  }).catch(()=>null).finally(()=>{snapshot.pending=null;});
  return snapshot.pending;
}
function warmPickerMetadata(state) {
  if(!state||state.nonRepository||navigatingWorktree)return;
  const signature=JSON.stringify([state.head,state.branch,state.staged?.length,state.changes?.length]);
  const folder=pickerSnapshot('worktrees',state.repo), changed=folder.signature!==signature;folder.signature=signature;
  for(const kind of ['worktrees','branches'])if(changed||Date.now()-pickerSnapshot(kind,state.repo).attempt>=15000)void fetchPickerMetadata(kind,state.repo);
}
function invalidatePickerMetadata(){pickerMetadata.clear();warmPickerMetadata(model.repo);}
// Pause with hidden native windows or the App's retained-but-hidden iframe.
setInterval(()=>{if(!document.hidden&&(!window.frameElement||window.frameElement.getClientRects().length)&&!model.busy)warmPickerMetadata(model.repo);},15000);
let worktreePickerRequest = 0, branchPickerRequest = 0;
async function openWorktrees(manage = false) {
  closePopovers();
  const request = ++worktreePickerRequest, root = model.repo?.repo;
  const title = manage ? 'Manage worktrees' : 'Working folders';
  const container = manage ? ui.modalContent : $('#worktree-picker-content');
  const stillOpen = () => request === worktreePickerRequest && model.repo?.repo === root && (manage ? !ui.modal.classList.contains('hidden') && $('#modal-title').textContent === title : !$('#worktree-popover').classList.contains('hidden'));
  if (manage) { $('#modal-title').textContent = title; ui.modal.classList.remove('hidden'); }
  else { $('#worktree-popover').classList.remove('hidden'); ui.repoName.setAttribute('aria-expanded','true'); positionPicker($('#worktree-popover'),ui.repoName); $('#close-worktrees').focus(); }
  const currentPath = document.createElement('p'); currentPath.className = 'repo-full-path'; currentPath.textContent = root;
  const loading = document.createElement('p'); loading.className='picker-pending';
  container.replaceChildren(currentPath, loading);
  const cached=manage?null:pickerSnapshot('worktrees',root).value;
  const timer=setTimeout(()=>{if(stillOpen())loading.textContent='Loading folders…';},300);
  let entries;
  try {entries=model.repo?.nonRepository?[]:cached??await fetchPickerMetadata('worktrees',root);}
  finally {clearTimeout(timer);}
  // A warm opening stays stable; refresh only the cache for the next opening.
  if(cached)void fetchPickerMetadata('worktrees',root);
  if (!stillOpen()) return;
  if (!entries) { loading.textContent = 'Could not load folders. Close this panel and try again.'; return; }
  container.innerHTML = `<div class="worktree-context"><small>Currently viewing</small><p class="repo-full-path">${escapeHtml(root)}</p><button id="copy-worktree-path" class="quiet-button">Copy full path</button><small class="worktree-sync">${escapeHtml(ui.syncState.textContent)}</small></div><p class="worktree-help">${model.repo?.nonRepository ? 'This folder is not a Git repository.' : 'Choose a folder to view its changes. This does not switch branches or move files.'}</p><div class="worktree-list">${entries.map((entry) => {
    const current = entry.path === root;
    if(current&&!manage)entry={...entry,branch:model.repo.branch,staged:model.repo.staged?.length??entry.staged,changes:model.repo.changes?.length??entry.changes,dirty:!!(model.repo.staged?.length||model.repo.changes?.length||model.repo.operation)};
    const name = entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path;
    const removable = !entry.main && !entry.invoking && !entry.retained && !current && entry.valid && !entry.locked && !entry.dirty && !entry.prunable;
    return `<div class="worktree-entry${current ? ' current' : ''}"><button class="worktree-choice" data-view-worktree="${escapeHtml(entry.path)}" ${current ? 'aria-current="location"' : ''} ${!entry.valid || entry.prunable ? 'disabled' : ''}><span class="worktree-choice-heading"><strong>${escapeHtml(name)}</strong>${current ? '<span class="worktree-current">✓ Currently viewing</span>' : ''}</span><span class="worktree-choice-branch">⑂ ${escapeHtml(entry.branch || 'Detached HEAD')}</span><span class="worktree-choice-path">${escapeHtml(entry.path)}</span><span class="worktree-choice-status">${!entry.valid || entry.prunable ? 'Unavailable' : entry.staged == null || entry.changes == null ? 'Status unavailable' : entry.dirty ? `${entry.staged} staged · ${entry.changes} unstaged` : 'Clean'}${entry.locked ? ` · Locked${entry.lockReason ? ': ' + escapeHtml(entry.lockReason) : ''}` : ''}${entry.main ? ' · Main folder' : ''}${entry.invoking ? ' · Session folder' : ''}</span></button>${manage && removable ? `<button class="quiet-button" data-remove-worktree="${escapeHtml(entry.path)}">Remove folder…</button>` : ''}</div>`;
  }).join('')}</div>${manage ? '<h3>Create worktree</h3><p>Creates a new sibling folder beside the currently viewed directory.</p><form id="create-worktree-form"><label>Sibling folder name<input id="worktree-folder" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" maxlength="100"></label><label>Branch<input id="worktree-branch" required></label><label><input id="worktree-new-branch" type="checkbox" checked> Create a new branch (uncheck to use an existing local branch)</label><button>Create worktree…</button></form><button id="back-to-worktrees" class="quiet-button worktree-manage">Back to working folders</button>' : model.repo?.nonRepository ? '' : '<button id="manage-worktrees" class="quiet-button worktree-manage">Manage worktrees…</button>'}`;
  if (!manage) { const context = container.querySelector('.worktree-context'); container.append(context); const manageButton = container.querySelector('#manage-worktrees'); if (manageButton) container.append(manageButton); }
  container.querySelector('#copy-worktree-path').addEventListener('click', async () => {
    const pathNode=container.querySelector('.repo-full-path');
    try { await navigator.clipboard.writeText(root); showToast('Path copied'); }
    catch { if(!pathNode?.isConnected)return; const range = document.createRange(); range.selectNodeContents(pathNode); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  });
  container.querySelector('#manage-worktrees')?.addEventListener('click', () => openWorktrees(true));
  container.querySelector('#back-to-worktrees')?.addEventListener('click', () => { ui.modal.classList.add('hidden'); void openWorktrees(); });
  const refreshManagement = async () => {
    if (stillOpen()) await openWorktrees(true);
  };
  container.querySelectorAll('[data-view-worktree]').forEach((button) => button.addEventListener('click', () => { if (button.dataset.viewWorktree === model.repo?.repo) { closePopovers(); ui.repoName.focus(); } else void viewWorktree(button.dataset.viewWorktree); }));
  container.querySelectorAll('[data-remove-worktree]').forEach((button) => button.addEventListener('click', async () => {
    const saved = worktreeViews.get(button.dataset.removeWorktree);
    if (saved && (saved.message || [...saved.files.values()].some((view) => view.commentComposer?.body))) return showToast('That view has unsaved drafts. Copy or clear them before removing its worktree.', true);
    const result = await unwrap(window.gittyGo.removeWorktree(button.dataset.removeWorktree));
    if (result && !result.cancelled) { worktreeViews.delete(button.dataset.removeWorktree); invalidatePickerMetadata(); await refreshManagement(); }
  }));
  container.querySelector('#create-worktree-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const result = await unwrap(window.gittyGo.createWorktree(container.querySelector('#worktree-folder').value, container.querySelector('#worktree-branch').value, container.querySelector('#worktree-new-branch').checked)); if (result && !result.cancelled) {invalidatePickerMetadata();await refreshManagement();} });
}
$('#choose-available-worktree').addEventListener('click', () => openWorktrees());
$('#initialize-repository').addEventListener('click', async () => { const result = await unwrap(window.gittyGo.initializeRepository()); if (result?.initialized) { const state = await unwrap(window.gittyGo.state()); if (state) renderRepo(state); } });
function positionPicker(picker, trigger) {
  const anchor = trigger.getBoundingClientRect(), top = anchor.bottom + 4;
  picker.style.top = `${top}px`; picker.style.right = 'auto';
  picker.style.left = `${Math.max(8,Math.min(anchor.left,innerWidth-picker.getBoundingClientRect().width-8))}px`;
  picker.style.maxHeight = `${Math.max(80,innerHeight-top-8)}px`;
}
function closePopovers() {
  if(!$('#worktree-popover').classList.contains('hidden'))worktreePickerRequest++;
  if(!ui.branchPopover.classList.contains('hidden'))branchPickerRequest++;
  ui.moreMenu.classList.add('hidden'); ui.branchPopover.classList.add('hidden'); $('#worktree-popover').classList.add('hidden');
  ui.repoName.setAttribute('aria-expanded','false'); $('#branch-button').setAttribute('aria-expanded','false');
  $('#worktree-picker-content').replaceChildren();
}
$('#more-button').addEventListener('click', (event) => { event.stopPropagation(); const open=ui.moreMenu.classList.contains('hidden'); closePopovers(); if(open) ui.moreMenu.classList.remove('hidden'); });
$('#branch-button').addEventListener('click', async (event) => { event.stopPropagation(); const open=ui.branchPopover.classList.contains('hidden'); closePopovers(); if(open) { ui.branchPopover.classList.remove('hidden'); $('#branch-button').setAttribute('aria-expanded','true'); positionPicker(ui.branchPopover,$('#branch-button')); $('#close-branches').focus(); await loadBranches(); } });
$('#close-branches').addEventListener('click', () => { closePopovers(); $('#branch-button').focus(); });
$('#close-worktrees').addEventListener('click', () => { closePopovers(); ui.repoName.focus(); });
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.popover') && !event.target.closest('#more-button') && !event.target.closest('#branch-button') && !event.target.closest('#repo-name')) closePopovers(); });
document.addEventListener('keydown', (event) => { if(event.key!=='Escape')return; const folder=!$('#worktree-popover').classList.contains('hidden'), branch=!ui.branchPopover.classList.contains('hidden'); if(folder||branch||!ui.moreMenu.classList.contains('hidden')) {event.preventDefault();event.stopPropagation();closePopovers();(folder?ui.repoName:branch?$('#branch-button'):$('#more-button')).focus();} });
window.addEventListener('resize',()=>{for(const [picker,trigger] of [[$('#worktree-popover'),ui.repoName],[ui.branchPopover,$('#branch-button')]])if(!picker.classList.contains('hidden'))positionPicker(picker,trigger);});
async function loadBranches() { const request=++branchPickerRequest, root=model.repo?.repo; const stillOpen=()=>request===branchPickerRequest&&!ui.branchPopover.classList.contains('hidden')&&model.repo?.repo===root; ui.branchList.textContent=''; ui.branchList.classList.add('picker-pending'); const cached=pickerSnapshot('branches',root).value; const timer=setTimeout(()=>{if(stillOpen())ui.branchList.textContent='Loading branches…';},300); let branches;try{branches=cached??await fetchPickerMetadata('branches',root);}finally{clearTimeout(timer);} if(cached)void fetchPickerMetadata('branches',root); if(!stillOpen())return; ui.branchList.classList.remove('picker-pending'); if (!branches) {ui.branchList.textContent='Could not load branches. Close this panel and try again.';return;} ui.branchList.innerHTML = `<p>Switch this directory’s branch: ${escapeHtml(model.repo.repo)}</p>` + branches.map(branch=>({...branch,current:branch.name===model.repo.branch})).map((branch) => `<button class="branch-row ${branch.current ? 'current' : ''}" data-branch="${escapeHtml(branch.name)}" ${branch.worktree && !branch.current ? `data-worktree="${escapeHtml(branch.worktree)}"` : ''}><span>${branch.current ? '✓ ' : ''}${escapeHtml(branch.name)}</span><span>${branch.worktree && !branch.current ? `View worktree · ${escapeHtml(branch.worktree)}` : escapeHtml(branch.upstream || 'Switch branch here')}</span></button>`).join(''); }
ui.branchList.addEventListener('click', async (event) => { const row = event.target.closest('.branch-row'); if (!row || row.classList.contains('current') || model.busy) return; if (row.dataset.worktree) { await viewWorktree(row.dataset.worktree); closePopovers(); return; } const result = await unwrap(window.gittyGo.switchBranch(row.dataset.branch), `Switched to ${row.dataset.branch}`); if (result !== null) {invalidatePickerMetadata();closePopovers();} });
$('#create-branch').addEventListener('click', async () => { const name = $('#new-branch-name').value.trim(); if (!name) return; const result = await unwrap(window.gittyGo.createBranch(name), `Created ${name}`); if (result !== null) {invalidatePickerMetadata(); $('#new-branch-name').value = ''; closePopovers(); } });

ui.moreMenu.addEventListener('click', async (event) => { const command = event.target.dataset.command; if (!command) return; closePopovers();
  if (command === 'fetch') await unwrap(window.gittyGo.fetch(), 'Fetch complete');
  if (command === 'pull') await unwrap(window.gittyGo.pull(), 'Pull complete');
  if (command === 'push') await unwrap(window.gittyGo.push(), 'Push complete');
  if (command === 'undo') { const result = await unwrap(window.gittyGo.undoCommit()); if (typeof result === 'string') showToast(`Undid ${result}`); }
  if (command === 'remotes') openRemotes();
  if (command === 'worktrees') openWorktrees(true);
});
async function openRemotes() { $('#modal-title').textContent = 'Manage remotes'; ui.modal.classList.remove('hidden'); ui.modalContent.innerHTML = '<div class="empty-sidebar">Loading remotes…</div>'; const remotes = await unwrap(window.gittyGo.remotes()); if (!remotes) return;
  ui.modalContent.innerHTML = `${remotes.length ? remotes.map((remote) => `<div class="remote-row"><strong>${escapeHtml(remote.name)}</strong><div><div class="remote-url">Fetch: ${escapeHtml(remote.fetchUrl)}</div><div class="remote-url">Push: ${escapeHtml(remote.pushUrl)}</div></div><button data-remove-remote="${escapeHtml(remote.name)}">Remove</button></div>`).join('') : '<div class="empty-sidebar">No remotes configured.</div>'}<div class="add-remote"><input id="remote-name" placeholder="Name" value="origin"/><input id="remote-url" placeholder="Remote URL"/><button id="add-remote">Add</button></div>`;
  $('#add-remote').addEventListener('click', async () => { const result = await unwrap(window.gittyGo.addRemote($('#remote-name').value, $('#remote-url').value), 'Remote added'); if (result !== null) openRemotes(); });
  ui.modalContent.querySelectorAll('[data-remove-remote]').forEach((button) => button.addEventListener('click', async () => { const result = await unwrap(window.gittyGo.removeRemote(button.dataset.removeRemote), 'Remote removed'); if (result !== null) openRemotes(); }));
}
ui.repoName.addEventListener('click', (event) => { event.stopPropagation(); if(!model.repo)return; if(!$('#worktree-popover').classList.contains('hidden')) {closePopovers();return;} void openWorktrees(); });
$('#close-modal').addEventListener('click', () => ui.modal.classList.add('hidden')); ui.modal.addEventListener('pointerdown', (event) => { if (event.target === ui.modal) ui.modal.classList.add('hidden'); });

async function focusReviewComment(commentId) {
  let comment = allReviewComments().find((item) => item.id === commentId);
  if (!comment) {
    const review = await unwrap(window.gittyGo.reviewState());
    if (review) model.review = review;
    comment = allReviewComments().find((item) => item.id === commentId);
  }
  if (!comment) return showToast('That comment is no longer active.', true);
  await setView('changes');
  const file = [...(model.repo?.changes || []), ...(model.repo?.staged || [])].find((item) => item.path === comment.anchor.path && item.section === comment.anchor.section);
  if (!file) return showToast('The commented change is no longer available in this section.', true);
  await selectFile(file);
  const thread = [...ui.content.querySelectorAll('[data-comment-id]')].find((element) => element.dataset.commentId === commentId);
  if (!thread) return showToast('The comment anchor is no longer present in the current diff.', true);
  thread.scrollIntoView({ block: 'center', behavior: 'smooth' });
  thread.classList.add('focused-comment');
  setTimeout(() => thread.classList.remove('focused-comment'), 1800);
}

window.gittyGo.onChanged(renderRepo);
window.gittyGo.onReviewChanged((review) => {
  if (navigatingWorktree || (review.worktreeRoot && model.repo?.repo !== review.worktreeRoot)) return;
  model.review = review; if (model.repo) renderFiles(); if (model.selected && model.diff) renderReview();
});
window.gittyGo.onFocusComment(focusReviewComment);
window.gittyGo.onSetCommitMessage((proposal) => {
  if(navigatingWorktree||!validProposal(proposal)||model.commitProposalSeen===proposal.proposalId)return;
  model.commitProposalSeen=proposal.proposalId;model.commitProposal=proposal.message?proposal:null;
  if(proposal.message&&!ui.commitMessage.value.trim())ui.commitMessage.value=proposal.message;
  updateCommitUi(); // Do not switch views, focus windows or overwrite a human draft.
});
window.gittyGo.onError((error) => showToast(error.message, true));
(async function initialize() {
  const [state, review] = await Promise.all([unwrap(window.gittyGo.state()), unwrap(window.gittyGo.reviewState())]);
  if (review) model.review = review;
  if (state) renderRepo(state);
})();
