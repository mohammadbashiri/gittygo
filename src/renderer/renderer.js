const $ = (selector) => document.querySelector(selector);
const ui = {
  repoName: $('#repo-name'), branchName: $('#branch-name'), syncState: $('#sync-state'), updatedLabel: $('#updated-label'),
  groups: $('#file-groups'), commitMessage: $('#commit-message'), commitButton: $('#commit-button'), amend: $('#amend-checkbox'), toolbar: $('#file-toolbar'),
  selectedStatus: $('#selected-status'), selectedPath: $('#selected-path'), fileAction: $('#file-action'), discardFile: $('#discard-file'),
  content: $('#content'), toast: $('#toast'), historyList: $('#history-list'), historyDetail: $('#history-detail'), historyCount: $('#history-count'),
  moreMenu: $('#more-menu'), branchPopover: $('#branch-popover'), branchList: $('#branch-list'), modal: $('#modal-backdrop'), modalContent: $('#modal-content'),
  selectionAction: $('#selection-action'), selectionCount: $('#selection-count'), applySelection: $('#apply-selection'),
};

const model = { repo: null, selected: null, diff: null, layout: 'unified', busy: false, view: 'changes', history: [], selectedCommit: null, commitDetail: null, selectedCommitFile: null, commitFileDiff: null, selectedLines: null, selectionAnchor: null };
const sidebarState = {
  changes: localStorage.getItem('git-review:sidebar:changes') === 'collapsed',
  history: localStorage.getItem('git-review:sidebar:history') === 'collapsed',
};
const escapeHtml = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const basename = (filePath) => filePath.split('/').pop();
const dirname = (filePath) => { const parts = filePath.split('/'); parts.pop(); return parts.length ? `${parts.join('/')}/` : ''; };
const fileKey = (file) => `${file.section}:${file.path}`;

function applySidebarState(view) {
  const container = $(`#${view}-view`); const button = container.querySelector('.sidebar-toggle'); const collapsed = sidebarState[view];
  container.classList.toggle('sidebar-collapsed', collapsed);
  button.textContent = collapsed ? '›' : '‹';
  button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${view === 'changes' ? 'Changes' : 'History'} sidebar`);
  button.setAttribute('aria-expanded', String(!collapsed));
}

document.querySelectorAll('.sidebar-toggle').forEach((button) => button.addEventListener('click', () => {
  const view = button.dataset.sidebar; sidebarState[view] = !sidebarState[view];
  localStorage.setItem(`git-review:sidebar:${view}`, sidebarState[view] ? 'collapsed' : 'expanded');
  applySidebarState(view);
}));
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

function renderFiles() {
  const groups = [{ title: 'Staged Changes', files: model.repo.staged }, { title: 'Changes', files: model.repo.changes }].filter((group) => group.files.length);
  if (!groups.length) { ui.groups.innerHTML = '<div class="empty-sidebar"><strong>Working tree clean</strong>There are no changes to review.</div>'; return; }
  ui.groups.innerHTML = groups.map((group) => `<section class="group"><header class="group-heading"><span>${group.title}</span><span class="count">${group.files.length}</span></header>${group.files.map((file) => `<button class="file-row ${file.conflicted ? 'conflicted' : ''} ${model.selected && fileKey(file) === fileKey(model.selected) ? 'selected' : ''}" data-file-key="${escapeHtml(fileKey(file))}" title="${file.conflicted ? 'Conflict: resolve outside Git Review before staging' : escapeHtml(file.path)}"><span class="file-status ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span><span class="file-path" title="${escapeHtml(file.path)}"><span class="file-dir">${escapeHtml(dirname(file.path))}</span>${escapeHtml(basename(file.path))}</span><span class="row-action" title="${file.section === 'staged' ? 'Unstage' : 'Stage'}">${file.section === 'staged' ? '−' : '+'}</span></button>`).join('')}</section>`).join('');
}

ui.groups.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return; const row = event.target.closest('.file-row'); if (!row || !model.repo) return;
  const file = [...model.repo.changes, ...model.repo.staged].find((item) => fileKey(item) === row.dataset.fileKey); if (!file) return;
  event.preventDefault(); if (event.target.closest('.row-action')) toggleFileStage(file); else selectFile(file);
});
ui.groups.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return; const row = event.target.closest('.file-row'); if (!row) return;
  const file = [...model.repo.changes, ...model.repo.staged].find((item) => fileKey(item) === row.dataset.fileKey); if (file) { event.preventDefault(); selectFile(file); }
});

function renderRepo(state) {
  const oldHead = model.repo?.head; model.repo = state; ui.repoName.textContent = state.name; ui.branchName.textContent = state.branch;
  ui.syncState.textContent = state.upstream ? `${state.upstream}  ↑${state.ahead} ↓${state.behind}` : 'No upstream';
  ui.syncState.title = state.operation ? `${state.operation} in progress` : state.upstream || 'No upstream configured';
  updateCommitUi();
  if (model.selected) {
    const stillPresent = [...state.changes, ...state.staged].find((file) => fileKey(file) === fileKey(model.selected));
    if (stillPresent) { model.selected = stillPresent; loadDiff(false); } else { model.selected = null; model.diff = null; clearLineSelection(); renderReview(); }
  }
  renderFiles(); if (!model.selected) renderReview();
  if (model.view === 'history' && oldHead && oldHead !== state.head) loadHistory();
  ui.updatedLabel.textContent = state.conflicted ? 'Conflicts need attention' : 'Updated just now';
  clearTimeout(renderRepo.timer); renderRepo.timer = setTimeout(() => { ui.updatedLabel.textContent = state.operation ? `${state.operation} in progress` : 'Live'; }, 1400);
}

async function selectFile(file) { model.selected = file; model.diff = null; clearLineSelection(); ui.content.scrollTop = 0; ui.content.scrollLeft = 0; renderFiles(); renderReview(); await loadDiff(true); }
async function loadDiff(showLoading) {
  if (!model.selected) return; const requestedKey = fileKey(model.selected);
  if (showLoading) ui.content.innerHTML = '<div class="empty-diff">Loading diff…</div>';
  const result = await unwrap(window.gitReview.diff(model.selected.path, model.selected.section));
  if (!result || !model.selected || requestedKey !== fileKey(model.selected)) return; model.diff = result; renderReview();
}
function renderReview() {
  if (!model.selected) { ui.toolbar.classList.add('hidden'); ui.content.innerHTML = '<div class="welcome"><div><div class="welcome-mark">✓</div><h2>Select a changed file</h2><p>Review, stage, and commit without opening an editor.</p></div></div>'; return; }
  ui.toolbar.classList.remove('hidden'); ui.selectedStatus.textContent = model.selected.status; ui.selectedPath.textContent = model.selected.path;
  ui.fileAction.textContent = model.selected.conflicted ? 'Conflict' : model.selected.section === 'staged' ? 'Unstage file' : 'Stage file';
  ui.fileAction.disabled = Boolean(model.selected.conflicted); ui.discardFile.disabled = Boolean(model.selected.conflicted); ui.discardFile.classList.toggle('hidden', model.selected.section === 'staged');
  if (!model.diff) return;
  if (model.diff.binary) { ui.content.innerHTML = '<div class="empty-diff">Binary file changed. Diff preview is unavailable.</div>'; return; }
  if (!model.diff.patch) { ui.content.innerHTML = '<div class="empty-diff">No textual changes to display.</div>'; return; }
  ui.content.innerHTML = renderDiff(model.diff.patch, model.diff.hunks, model.selected.section, model.layout); bindHunkActions(); updateSelectionUi();
}
function parseHunkRange(header) { const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/); return match ? { old: Number(match[1]), next: Number(match[3]) } : { old: 0, next: 0 }; }
function splitPatch(patch) { const lines = patch.split('\n'); const first = lines.findIndex((line) => line.startsWith('@@ ')); return { header: first < 0 ? lines : lines.slice(0, first) }; }
function renderDiff(patch, hunks, section, layout, readOnly = false) {
  const usefulHeader = splitPatch(patch).header.filter((line) => line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ '));
  return `<div class="diff ${layout}${readOnly ? ' read-only' : ''}"><div class="file-header">${usefulHeader.map(escapeHtml).join('\n')}</div>${hunks.map((hunk) => renderHunk(hunk, section, layout, readOnly)).join('')}</div>`;
}
function renderHunk(hunk, section, layout, readOnly = false) {
  const action = section === 'staged' ? 'Unstage hunk' : 'Stage hunk';
  const actions = readOnly ? '' : `<span class="hunk-actions"><button class="toggle-hunk">${action}</button>${section === 'unstaged' ? '<button class="discard-hunk">Discard</button>' : ''}</span>`;
  return `<section class="hunk" data-hunk="${hunk.id}"><header class="hunk-header"><span>${escapeHtml(hunk.header)}</span>${actions}</header>${layout === 'split' ? renderSplitLines(hunk) : renderUnifiedLines(hunk, readOnly)}</section>`;
}
function renderUnifiedLines(hunk, readOnly = false) {
  const range = parseHunkRange(hunk.header); let oldLine = range.old; let newLine = range.next;
  return hunk.lines.map((line, index) => {
    if (line === '' && index === hunk.lines.length - 1) return '';
    const marker = line[0] || ' '; const metadata = marker === '\\'; const kind = marker === '+' ? 'add' : marker === '-' ? 'del' : 'context';
    const oldNumber = metadata || marker === '+' ? '' : oldLine++; const newNumber = metadata || marker === '-' ? '' : newLine++;
    const selectable = !readOnly && (marker === '+' || marker === '-'); const selected = model.selectedLines?.hunkId === hunk.id && model.selectedLines.indexes.has(index);
    return `<div class="diff-row ${kind}${selectable ? ' selectable' : ''}${selected ? ' line-selected' : ''}" ${selectable ? `data-hunk="${hunk.id}" data-line="${index}" title="Click to select; Shift-click to select a range"` : ''}><span class="line-no">${oldNumber}</span><span class="line-no">${newNumber}</span><span class="marker">${metadata ? '' : escapeHtml(marker)}</span><span class="code">${escapeHtml(metadata ? line : line.slice(1))}</span></div>`;
  }).join('');
}
function renderSplitLines(hunk) {
  const range = parseHunkRange(hunk.header); let oldLine = range.old; let newLine = range.next; const rows = []; let removed = []; let added = [];
  const flush = () => { const length = Math.max(removed.length, added.length); for (let i = 0; i < length; i += 1) rows.push({ left: removed[i] || null, right: added[i] || null }); removed = []; added = []; };
  hunk.lines.forEach((line, index) => { if (line === '' && index === hunk.lines.length - 1) return; if (line.startsWith('-')) removed.push({ number: oldLine++, text: line.slice(1), kind: 'del', marker: '−' }); else if (line.startsWith('+')) added.push({ number: newLine++, text: line.slice(1), kind: 'add', marker: '+' }); else { flush(); const text = line.startsWith('\\') ? line : line.slice(1); rows.push({ left: { number: line.startsWith('\\') ? '' : oldLine++, text, kind: 'context', marker: '' }, right: { number: line.startsWith('\\') ? '' : newLine++, text, kind: 'context', marker: '' } }); } }); flush();
  const cell = (value) => value ? `<div class="split-cell ${value.kind}"><span class="line-no">${value.number}</span><span class="marker">${value.marker}</span><span class="code">${escapeHtml(value.text)}</span></div>` : '<div class="split-cell empty"></div>';
  return rows.map((row) => `<div class="split-row">${cell(row.left)}${cell(row.right)}</div>`).join('');
}
function bindHunkActions() {
  ui.content.querySelectorAll('.hunk').forEach((element) => { const hunk = model.diff.hunks[Number(element.dataset.hunk)];
    element.querySelector('.toggle-hunk').addEventListener('click', async () => { const staged = model.selected.section === 'staged'; await unwrap(staged ? window.gitReview.unstageHunk(hunk.patch, model.selected.path) : window.gitReview.stageHunk(hunk.patch, model.selected.path), staged ? 'Hunk unstaged' : 'Hunk staged'); });
    element.querySelector('.discard-hunk')?.addEventListener('click', () => unwrap(window.gitReview.discardHunk(hunk.patch, model.selected.path), 'Hunk discarded'));
  });
}

ui.content.addEventListener('pointerdown', (event) => {
  const row = event.target.closest('.diff-row.selectable'); if (!row || model.layout !== 'unified') return; event.preventDefault();
  const hunkId = Number(row.dataset.hunk); const line = Number(row.dataset.line); const hunk = model.diff.hunks[hunkId];
  if (!model.selectedLines || model.selectedLines.hunkId !== hunkId) model.selectedLines = { hunkId, indexes: new Set() };
  if (event.shiftKey && model.selectionAnchor?.hunkId === hunkId) {
    const [start, end] = [model.selectionAnchor.line, line].sort((a, b) => a - b);
    hunk.lines.forEach((text, index) => { if (index >= start && index <= end && ['+', '-'].includes(text[0])) model.selectedLines.indexes.add(index); });
  } else {
    if (model.selectedLines.indexes.has(line)) model.selectedLines.indexes.delete(line); else model.selectedLines.indexes.add(line);
    model.selectionAnchor = { hunkId, line };
  }
  renderReview();
});
function clearLineSelection() { model.selectedLines = null; model.selectionAnchor = null; ui.selectionAction.classList.add('hidden'); }
function updateSelectionUi() {
  const count = model.selectedLines?.indexes.size || 0; ui.selectionAction.classList.toggle('hidden', count === 0); if (!count) return;
  ui.selectionCount.textContent = `${count} changed ${count === 1 ? 'line' : 'lines'} selected`;
  ui.applySelection.textContent = model.selected.section === 'staged' ? 'Unstage selected' : 'Stage selected';
}
ui.applySelection.addEventListener('click', async () => {
  if (!model.selectedLines?.indexes.size) return; const hunk = model.diff.hunks[model.selectedLines.hunkId];
  const result = await unwrap(window.gitReview.stageSelected(hunk.patch, [...model.selectedLines.indexes], model.selected.section, model.selected.path), model.selected.section === 'staged' ? 'Selected lines unstaged' : 'Selected lines staged');
  if (result !== null) clearLineSelection();
});
$('#clear-selection').addEventListener('click', () => { clearLineSelection(); renderReview(); });

async function toggleFileStage(file = model.selected) { if (!file || model.busy) return; await unwrap(file.section === 'staged' ? window.gitReview.unstageFile(file.path) : window.gitReview.stageFile(file.path), file.section === 'staged' ? 'File unstaged' : 'File staged'); }
ui.fileAction.addEventListener('click', () => toggleFileStage());
ui.discardFile.addEventListener('click', () => model.selected && unwrap(window.gitReview.discardFile(model.selected.path), 'Changes discarded'));
function updateCommitUi() {
  const staged = model.repo?.staged.length || 0; const amend = ui.amend.checked; const hasMessage = Boolean(ui.commitMessage.value.trim());
  ui.commitButton.disabled = amend ? !staged && !hasMessage : !staged || !hasMessage;
  ui.commitButton.textContent = amend ? 'Amend last commit' : staged ? `Commit ${staged} ${staged === 1 ? 'file' : 'files'}` : 'Commit';
  ui.commitMessage.placeholder = amend ? 'Leave empty to keep the existing message…' : 'Describe the staged changes…';
}
ui.commitMessage.addEventListener('input', updateCommitUi); ui.amend.addEventListener('change', updateCommitUi);
ui.commitMessage.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') ui.commitButton.click(); });
ui.commitButton.addEventListener('click', async () => { if (ui.commitButton.disabled || model.busy) return; const wasAmend = ui.amend.checked; const hash = await unwrap(window.gitReview.commit(ui.commitMessage.value, wasAmend)); if (typeof hash === 'string') { ui.commitMessage.value = ''; ui.amend.checked = false; updateCommitUi(); showToast(`${wasAmend ? 'Amended' : 'Committed'} as ${hash}`); } });
document.querySelectorAll('[data-layout]').forEach((button) => button.addEventListener('click', () => { model.layout = button.dataset.layout; clearLineSelection(); document.querySelectorAll('[data-layout]').forEach((item) => item.classList.toggle('active', item === button)); renderReview(); }));

async function setView(view) {
  model.view = view; document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#changes-view').classList.toggle('hidden', view !== 'changes'); $('#history-view').classList.toggle('hidden', view !== 'history');
  if (view === 'history') await loadHistory();
}
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
async function loadHistory() {
  ui.historyList.innerHTML = '<div class="empty-diff">Loading history…</div>'; const history = await unwrap(window.gitReview.history(200)); if (!history) return;
  model.history = layoutHistory(history); ui.historyCount.textContent = `${history.length} commits`;
  ui.historyList.innerHTML = history.length ? model.history.map((commit) => {
    const width = Math.max(1, commit.laneCount) * 16 + 12;
    const lines = Array.from({ length: commit.laneCount }, (_, lane) => `<i class="graph-line" style="left:${lane * 16 + 8}px"></i>`).join('');
    return `<button class="commit-row ${model.selectedCommit === commit.hash ? 'selected' : ''}" style="--graph-width:${width}px" data-commit="${commit.hash}"><span class="graph-cell">${lines}<i class="graph-dot" style="left:${commit.lane * 16 + 8}px"></i></span><span class="commit-main"><span class="commit-subject">${escapeHtml(commit.subject)}</span><span class="commit-meta"><span>${escapeHtml(commit.author)}</span><span>${formatRelativeDate(commit.date)}</span></span>${commit.refs.length ? `<span class="ref-badges">${commit.refs.map((ref) => `<i class="ref-badge">${escapeHtml(ref.replace(/^HEAD -> /, ''))}</i>`).join('')}</span>` : ''}</span><span class="commit-hash">${commit.shortHash}</span></button>`;
  }).join('') : '<div class="empty-sidebar">No commits yet.</div>'; 
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
ui.historyList.addEventListener('click', async (event) => {
  const row = event.target.closest('.commit-row'); if (!row) return;
  model.selectedCommit = row.dataset.commit; model.commitDetail = null; model.selectedCommitFile = null; model.commitFileDiff = null;
  ui.historyList.querySelectorAll('.commit-row').forEach((item) => item.classList.toggle('selected', item === row));
  ui.historyDetail.innerHTML = '<div class="empty-diff">Loading commit…</div>';
  const detail = await unwrap(window.gitReview.commitDetails(model.selectedCommit));
  if (!detail || model.selectedCommit !== row.dataset.commit) return;
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
    if (!file || file === model.selectedCommitFile) return;
    model.selectedCommitFile = file; model.commitFileDiff = null; renderCommitDetail(); await loadCommitFileDiff(file);
  }));
  ui.historyDetail.querySelectorAll('[data-history-layout]').forEach((button) => button.addEventListener('click', () => {
    model.layout = button.dataset.historyLayout; renderCommitDetail();
  }));
}

async function loadCommitFileDiff(file) {
  const commitHash = model.selectedCommit; const requestedPath = file.path;
  const result = await unwrap(window.gitReview.commitFileDiff(commitHash, file.oldPath, file.path));
  if (!result || model.selectedCommit !== commitHash || model.selectedCommitFile?.path !== requestedPath) return;
  model.commitFileDiff = result; renderCommitDetail();
}

function closePopovers() { ui.moreMenu.classList.add('hidden'); ui.branchPopover.classList.add('hidden'); }
$('#more-button').addEventListener('click', (event) => { event.stopPropagation(); ui.moreMenu.classList.toggle('hidden'); ui.branchPopover.classList.add('hidden'); });
$('#branch-button').addEventListener('click', async (event) => { event.stopPropagation(); ui.moreMenu.classList.add('hidden'); ui.branchPopover.classList.toggle('hidden'); if (!ui.branchPopover.classList.contains('hidden')) await loadBranches(); });
$('#close-branches').addEventListener('click', closePopovers); document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.popover') && !event.target.closest('#more-button') && !event.target.closest('#branch-button')) closePopovers(); });
async function loadBranches() { const branches = await unwrap(window.gitReview.branches()); if (!branches) return; ui.branchList.innerHTML = branches.map((branch) => `<button class="branch-row ${branch.current ? 'current' : ''}" data-branch="${escapeHtml(branch.name)}"><span>${branch.current ? '✓ ' : ''}${escapeHtml(branch.name)}</span><span>${escapeHtml(branch.upstream || '')}</span></button>`).join(''); }
ui.branchList.addEventListener('click', async (event) => { const row = event.target.closest('.branch-row'); if (!row || row.classList.contains('current')) return; const result = await unwrap(window.gitReview.switchBranch(row.dataset.branch), `Switched to ${row.dataset.branch}`); if (result !== null) closePopovers(); });
$('#create-branch').addEventListener('click', async () => { const name = $('#new-branch-name').value.trim(); if (!name) return; const result = await unwrap(window.gitReview.createBranch(name), `Created ${name}`); if (result !== null) { $('#new-branch-name').value = ''; closePopovers(); } });

ui.moreMenu.addEventListener('click', async (event) => { const command = event.target.dataset.command; if (!command) return; closePopovers();
  if (command === 'fetch') await unwrap(window.gitReview.fetch(), 'Fetch complete');
  if (command === 'pull') await unwrap(window.gitReview.pull(), 'Pull complete');
  if (command === 'push') await unwrap(window.gitReview.push(), 'Push complete');
  if (command === 'undo') { const result = await unwrap(window.gitReview.undoCommit()); if (typeof result === 'string') showToast(`Undid ${result}`); }
  if (command === 'remotes') openRemotes();
});
$('#fetch-button').addEventListener('click', () => unwrap(window.gitReview.fetch(), 'Fetch complete'));
async function openRemotes() { ui.modal.classList.remove('hidden'); ui.modalContent.innerHTML = '<div class="empty-sidebar">Loading remotes…</div>'; const remotes = await unwrap(window.gitReview.remotes()); if (!remotes) return;
  ui.modalContent.innerHTML = `${remotes.length ? remotes.map((remote) => `<div class="remote-row"><strong>${escapeHtml(remote.name)}</strong><div><div class="remote-url">Fetch: ${escapeHtml(remote.fetchUrl)}</div><div class="remote-url">Push: ${escapeHtml(remote.pushUrl)}</div></div><button data-remove-remote="${escapeHtml(remote.name)}">Remove</button></div>`).join('') : '<div class="empty-sidebar">No remotes configured.</div>'}<div class="add-remote"><input id="remote-name" placeholder="Name" value="origin"/><input id="remote-url" placeholder="Remote URL"/><button id="add-remote">Add</button></div>`;
  $('#add-remote').addEventListener('click', async () => { const result = await unwrap(window.gitReview.addRemote($('#remote-name').value, $('#remote-url').value), 'Remote added'); if (result !== null) openRemotes(); });
  ui.modalContent.querySelectorAll('[data-remove-remote]').forEach((button) => button.addEventListener('click', async () => { const result = await unwrap(window.gitReview.removeRemote(button.dataset.removeRemote), 'Remote removed'); if (result !== null) openRemotes(); }));
}
$('#close-modal').addEventListener('click', () => ui.modal.classList.add('hidden')); ui.modal.addEventListener('pointerdown', (event) => { if (event.target === ui.modal) ui.modal.classList.add('hidden'); });

window.gitReview.onChanged(renderRepo); window.gitReview.onError((error) => showToast(error.message, true));
(async function initialize() { const state = await unwrap(window.gitReview.state()); if (state) renderRepo(state); })();
