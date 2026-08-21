const ui = {
  repoName: document.querySelector('#repo-name'),
  branchName: document.querySelector('#branch-name'),
  updatedLabel: document.querySelector('#updated-label'),
  groups: document.querySelector('#file-groups'),
  commitPanel: document.querySelector('#commit-panel'),
  commitMessage: document.querySelector('#commit-message'),
  commitButton: document.querySelector('#commit-button'),
  toolbar: document.querySelector('#file-toolbar'),
  selectedStatus: document.querySelector('#selected-status'),
  selectedPath: document.querySelector('#selected-path'),
  fileAction: document.querySelector('#file-action'),
  discardFile: document.querySelector('#discard-file'),
  content: document.querySelector('#content'),
  toast: document.querySelector('#toast'),
};

const model = {
  repo: null,
  selected: null,
  diff: null,
  layout: 'unified',
  busy: false,
};

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function basename(filePath) {
  return filePath.split('/').pop();
}

function dirname(filePath) {
  const parts = filePath.split('/');
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
}

function showToast(message, error = false) {
  ui.toast.textContent = message;
  ui.toast.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { ui.toast.className = 'toast'; }, 3200);
}

async function unwrap(promise, successMessage) {
  model.busy = true;
  const response = await promise;
  model.busy = false;
  if (!response.ok) {
    showToast(response.error.message, true);
    return null;
  }
  if (successMessage && !response.result?.cancelled) showToast(successMessage);
  return response.result;
}

function fileKey(file) {
  return `${file.section}:${file.path}`;
}

function renderFiles() {
  const groups = [
    { title: 'Staged Changes', files: model.repo.staged },
    { title: 'Changes', files: model.repo.changes },
  ].filter((group) => group.files.length);

  if (!groups.length) {
    ui.groups.innerHTML = `
      <div class="empty-sidebar">
        <strong>Working tree clean</strong>
        There are no changes to review.
      </div>`;
    return;
  }

  ui.groups.innerHTML = groups.map((group) => `
    <section class="group">
      <header class="group-heading"><span>${group.title}</span><span class="count">${group.files.length}</span></header>
      ${group.files.map((file) => `
        <button class="file-row ${model.selected && fileKey(file) === fileKey(model.selected) ? 'selected' : ''}" data-file-key="${escapeHtml(fileKey(file))}">
          <span class="file-status ${escapeHtml(file.status)}">${escapeHtml(file.status)}</span>
          <span class="file-path" title="${escapeHtml(file.path)}"><span class="file-dir">${escapeHtml(dirname(file.path))}</span>${escapeHtml(basename(file.path))}</span>
          <span class="row-action" title="${file.section === 'staged' ? 'Unstage' : 'Stage'}">${file.section === 'staged' ? '−' : '+'}</span>
        </button>
      `).join('')}
    </section>
  `).join('');

}

// Use pointer-down delegation on the stable sidebar container. This responds
// immediately and remains reliable when live repository updates replace rows.
ui.groups.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const row = event.target.closest('.file-row');
  if (!row || !model.repo) return;
  const allFiles = [...model.repo.changes, ...model.repo.staged];
  const file = allFiles.find((item) => fileKey(item) === row.dataset.fileKey);
  if (!file) return;
  event.preventDefault();
  if (event.target.closest('.row-action')) toggleFileStage(file);
  else selectFile(file);
});

function renderRepo(state) {
  model.repo = state;
  ui.repoName.textContent = state.name;
  ui.branchName.textContent = state.branch;
  ui.commitButton.disabled = state.staged.length === 0 || !ui.commitMessage.value.trim();
  ui.commitButton.textContent = `Commit ${state.staged.length || ''} ${state.staged.length === 1 ? 'file' : 'files'}`.trim();

  if (model.selected) {
    const allFiles = [...state.changes, ...state.staged];
    const stillPresent = allFiles.find((file) => fileKey(file) === fileKey(model.selected));
    if (stillPresent) {
      model.selected = stillPresent;
      loadDiff(false);
    } else {
      model.selected = null;
      model.diff = null;
      renderReview();
    }
  }

  renderFiles();
  if (!model.selected) renderReview();
  ui.updatedLabel.textContent = 'Updated just now';
  clearTimeout(renderRepo.timer);
  renderRepo.timer = setTimeout(() => { ui.updatedLabel.textContent = 'Live'; }, 1400);
}

async function selectFile(file) {
  model.selected = file;
  model.diff = null;
  ui.content.scrollTop = 0;
  ui.content.scrollLeft = 0;
  renderFiles();
  renderReview();
  await loadDiff(true);
}

async function loadDiff(showLoading) {
  if (!model.selected) return;
  const requestedKey = fileKey(model.selected);
  if (showLoading) ui.content.innerHTML = '<div class="empty-diff">Loading diff…</div>';
  const result = await unwrap(window.gitReview.diff(model.selected.path, model.selected.section));
  if (!result || !model.selected || requestedKey !== fileKey(model.selected)) return;
  model.diff = result;
  renderReview();
}

function renderReview() {
  if (!model.selected) {
    ui.toolbar.classList.add('hidden');
    ui.content.innerHTML = `
      <div class="welcome">
        <div><div class="welcome-mark">✓</div><h2>Select a changed file</h2><p>Review, stage, and commit without opening an editor.</p></div>
      </div>`;
    return;
  }

  ui.toolbar.classList.remove('hidden');
  ui.selectedStatus.textContent = model.selected.status;
  ui.selectedPath.textContent = model.selected.path;
  ui.fileAction.textContent = model.selected.section === 'staged' ? 'Unstage file' : 'Stage file';
  ui.discardFile.classList.toggle('hidden', model.selected.section === 'staged');

  if (!model.diff) return;
  if (model.diff.binary) {
    ui.content.innerHTML = '<div class="empty-diff">Binary file changed. Diff preview is unavailable.</div>';
    return;
  }
  if (!model.diff.patch) {
    ui.content.innerHTML = '<div class="empty-diff">No textual changes to display.</div>';
    return;
  }

  ui.content.innerHTML = renderDiff(model.diff.patch, model.diff.hunks, model.selected.section, model.layout);
  bindHunkActions();
}

function parseHunkRange(header) {
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  return match ? { old: Number(match[1]), next: Number(match[3]) } : { old: 0, next: 0 };
}

function splitPatch(patch) {
  const lines = patch.split('\n');
  const first = lines.findIndex((line) => line.startsWith('@@ '));
  return { header: first < 0 ? lines : lines.slice(0, first), body: first < 0 ? [] : lines.slice(first) };
}

function renderDiff(patch, hunks, section, layout) {
  const { header } = splitPatch(patch);
  const usefulHeader = header.filter((line) => line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ '));
  return `
    <div class="diff ${layout}">
      <div class="file-header">${usefulHeader.map(escapeHtml).join('\n')}</div>
      ${hunks.map((hunk) => renderHunk(hunk, section, layout)).join('')}
    </div>`;
}

function renderHunk(hunk, section, layout) {
  const action = section === 'staged' ? 'Unstage hunk' : 'Stage hunk';
  return `
    <section class="hunk" data-hunk="${hunk.id}">
      <header class="hunk-header">
        <span>${escapeHtml(hunk.header)}</span>
        <span class="hunk-actions">
          <button class="toggle-hunk">${action}</button>
          ${section === 'unstaged' ? '<button class="discard-hunk">Discard</button>' : ''}
        </span>
      </header>
      ${layout === 'split' ? renderSplitLines(hunk) : renderUnifiedLines(hunk)}
    </section>`;
}

function renderUnifiedLines(hunk) {
  const range = parseHunkRange(hunk.header);
  let oldLine = range.old;
  let newLine = range.next;
  return hunk.lines.map((line) => {
    if (line === '' && hunk.lines.at(-1) === line) return '';
    const marker = line[0] || ' ';
    const metadata = marker === '\\';
    const kind = marker === '+' ? 'add' : marker === '-' ? 'del' : 'context';
    const oldNumber = metadata || marker === '+' ? '' : oldLine++;
    const newNumber = metadata || marker === '-' ? '' : newLine++;
    return `<div class="diff-row ${kind}"><span class="line-no">${oldNumber}</span><span class="line-no">${newNumber}</span><span class="marker">${metadata ? '' : escapeHtml(marker)}</span><span class="code">${escapeHtml(metadata ? line : line.slice(1))}</span></div>`;
  }).join('');
}

function renderSplitLines(hunk) {
  const range = parseHunkRange(hunk.header);
  let oldLine = range.old;
  let newLine = range.next;
  const rows = [];
  let removed = [];
  let added = [];

  const flush = () => {
    const length = Math.max(removed.length, added.length);
    for (let index = 0; index < length; index += 1) {
      rows.push({ left: removed[index] || null, right: added[index] || null });
    }
    removed = [];
    added = [];
  };

  hunk.lines.forEach((line, index) => {
    if (line === '' && index === hunk.lines.length - 1) return;
    if (line.startsWith('-')) removed.push({ number: oldLine++, text: line.slice(1), kind: 'del', marker: '−' });
    else if (line.startsWith('+')) added.push({ number: newLine++, text: line.slice(1), kind: 'add', marker: '+' });
    else if (line.startsWith('\\')) {
      flush();
      rows.push({
        left: { number: '', text: line, kind: 'context', marker: '' },
        right: { number: '', text: line, kind: 'context', marker: '' },
      });
    } else {
      flush();
      const text = line.slice(1);
      rows.push({
        left: { number: oldLine++, text, kind: 'context', marker: '' },
        right: { number: newLine++, text, kind: 'context', marker: '' },
      });
    }
  });
  flush();

  const cell = (value) => value
    ? `<div class="split-cell ${value.kind}"><span class="line-no">${value.number}</span><span class="marker">${value.marker}</span><span class="code">${escapeHtml(value.text)}</span></div>`
    : '<div class="split-cell empty"></div>';
  return rows.map((row) => `<div class="split-row">${cell(row.left)}${cell(row.right)}</div>`).join('');
}

function bindHunkActions() {
  ui.content.querySelectorAll('.hunk').forEach((element) => {
    const hunk = model.diff.hunks[Number(element.dataset.hunk)];
    element.querySelector('.toggle-hunk').addEventListener('click', async () => {
      const staged = model.selected.section === 'staged';
      await unwrap(
        staged ? window.gitReview.unstageHunk(hunk.patch) : window.gitReview.stageHunk(hunk.patch),
        staged ? 'Hunk unstaged' : 'Hunk staged',
      );
    });
    element.querySelector('.discard-hunk')?.addEventListener('click', async () => {
      await unwrap(window.gitReview.discardHunk(hunk.patch), 'Hunk discarded');
    });
  });
}

async function toggleFileStage(file = model.selected) {
  if (!file || model.busy) return;
  await unwrap(
    file.section === 'staged' ? window.gitReview.unstageFile(file.path) : window.gitReview.stageFile(file.path),
    file.section === 'staged' ? 'File unstaged' : 'File staged',
  );
}

ui.fileAction.addEventListener('click', () => toggleFileStage());
ui.discardFile.addEventListener('click', async () => {
  if (!model.selected || model.busy) return;
  await unwrap(window.gitReview.discardFile(model.selected.path), 'Changes discarded');
});

ui.commitMessage.addEventListener('input', () => {
  ui.commitButton.disabled = !model.repo?.staged.length || !ui.commitMessage.value.trim();
});
ui.commitMessage.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') ui.commitButton.click();
});
ui.commitButton.addEventListener('click', async () => {
  if (ui.commitButton.disabled || model.busy) return;
  const hash = await unwrap(window.gitReview.commit(ui.commitMessage.value));
  if (hash) {
    ui.commitMessage.value = '';
    showToast(`Committed as ${hash}`);
  }
});

document.querySelectorAll('[data-layout]').forEach((button) => {
  button.addEventListener('click', () => {
    model.layout = button.dataset.layout;
    document.querySelectorAll('[data-layout]').forEach((item) => item.classList.toggle('active', item === button));
    renderReview();
  });
});

window.gitReview.onChanged(renderRepo);
window.gitReview.onError((error) => showToast(error.message, true));

(async function initialize() {
  const state = await unwrap(window.gitReview.state());
  if (state) renderRepo(state);
})();
