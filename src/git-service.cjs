const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

class GitError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'GitError';
    this.details = details;
  }
}

async function git(repo, args, options = {}) {
  if (options.input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', repo, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => reject(new GitError(error.message, `git ${args.join(' ')}`)));
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new GitError(stderr.trim() || `Git exited with status ${code}`, `git ${args.join(' ')}`));
      });
      child.stdin.end(options.input);
    });
  }

  try {
    const result = await execFileAsync('git', ['-C', repo, ...args], {
      encoding: options.encoding || 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw new GitError(
      error.stderr?.trim() || error.message || 'Git command failed',
      `git ${args.join(' ')}`,
    );
  }
}

async function resolveRepository(inputPath) {
  const candidate = path.resolve(inputPath || process.cwd());
  const stat = await fs.stat(candidate).catch(() => null);
  const cwd = stat?.isFile() ? path.dirname(candidate) : candidate;
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  return fs.realpath(path.resolve(root));
}

async function getRepositoryIdentity(inputPath) {
  const worktreeRoot = await resolveRepository(inputPath);
  const [gitDirectoryValue, gitCommonDirectoryValue] = await Promise.all([
    git(worktreeRoot, ['rev-parse', '--git-dir']),
    git(worktreeRoot, ['rev-parse', '--git-common-dir']),
  ]);
  const gitDirectory = await fs.realpath(path.resolve(worktreeRoot, gitDirectoryValue.trim()));
  const gitCommonDirectory = await fs.realpath(path.resolve(worktreeRoot, gitCommonDirectoryValue.trim()));
  const repoIdentity = require('node:crypto').createHash('sha256')
    .update(`${gitCommonDirectory}\0${worktreeRoot}`)
    .digest('hex');
  return { worktreeRoot, gitDirectory, gitCommonDirectory, repoIdentity };
}

function parseStatus(raw) {
  if (!raw) return [];
  const entries = raw.split('\0');
  const files = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;

    const x = entry[0];
    const y = entry[1];
    let filePath = entry.slice(3);
    let originalPath = null;

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      originalPath = entries[index + 1] || null;
      index += 1;
    }

    files.push({
      path: filePath,
      originalPath,
      indexStatus: x,
      worktreeStatus: y,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' || x === '?',
      untracked: x === '?' && y === '?',
      conflicted: x === 'U' || y === 'U' || ['AA', 'DD'].includes(`${x}${y}`),
    });
  }

  return files;
}

function displayStatus(file, staged) {
  const code = staged ? file.indexStatus : file.worktreeStatus;
  if (file.untracked) return 'A';
  return code === ' ' || code === '?' ? 'M' : code;
}

async function getState(repo) {
  const [rawStatus, branch, head, upstream, operation] = await Promise.all([
    git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(repo, ['branch', '--show-current']),
    git(repo, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
    git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
    getOperationState(repo),
  ]);

  const files = parseStatus(rawStatus);
  const staged = files
    .filter((file) => file.staged)
    .map((file) => ({ ...file, section: 'staged', status: displayStatus(file, true) }));
  const changes = files
    .filter((file) => file.unstaged)
    .map((file) => ({ ...file, section: 'unstaged', status: displayStatus(file, false) }));

  let ahead = 0;
  let behind = 0;
  if (upstream.trim()) {
    const counts = (await git(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream.trim()}`]).catch(() => '0\t0')).trim().split(/\s+/);
    ahead = Number(counts[0]) || 0;
    behind = Number(counts[1]) || 0;
  }

  return {
    repo,
    name: path.basename(repo),
    branch: branch.trim() || 'detached',
    head: head.trim(),
    upstream: upstream.trim() || null,
    ahead,
    behind,
    operation,
    conflicted: files.some((file) => file.indexStatus === 'U' || file.worktreeStatus === 'U' || ['AA', 'DD'].includes(`${file.indexStatus}${file.worktreeStatus}`)),
    staged,
    changes,
  };
}

async function getOperationState(repo) {
  const gitDir = (await git(repo, ['rev-parse', '--git-dir'])).trim();
  const absoluteGitDir = path.resolve(repo, gitDir);
  const exists = async (name) => Boolean(await fs.stat(path.join(absoluteGitDir, name)).catch(() => null));
  if (await exists('MERGE_HEAD')) return 'merge';
  if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (await exists('REVERT_HEAD')) return 'revert';
  if (await exists('rebase-merge') || await exists('rebase-apply')) return 'rebase';
  return null;
}

async function getDiff(repo, filePath, section) {
  const args = ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--unified=3'];
  if (section === 'staged') args.push('--cached');
  args.push('--', filePath);
  let patch = await git(repo, args);

  if (!patch && section === 'unstaged') {
    const state = await getState(repo);
    const file = state.changes.find((item) => item.path === filePath);
    if (file?.untracked) {
      const buffer = await fs.readFile(path.join(repo, filePath)).catch(() => null);
      if (buffer === null || buffer.includes(0)) return { patch: '', binary: true };
      const lines = buffer.toString('utf8').split('\n');
      const body = lines
        .map((line, index) => (index === lines.length - 1 && line === '' ? null : `+${line}`))
        .filter((line) => line !== null)
        .join('\n');
      patch = [
        `diff --git a/${filePath} b/${filePath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${Math.max(0, lines.length - (lines.at(-1) === '' ? 1 : 0))} @@`,
        body,
        '',
      ].join('\n');
    }
  }

  return { patch, binary: patch.includes('Binary files ') || patch.includes('GIT binary patch') };
}

function extractHunks(patch) {
  const lines = patch.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@ '));
  if (firstHunk < 0) return [];
  const header = lines.slice(0, firstHunk);
  const hunks = [];
  let current = null;

  for (let index = firstHunk; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('@@ ')) {
      if (current) hunks.push(current);
      current = { id: hunks.length, header: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);

  return hunks.map((hunk, index) => ({
    ...hunk,
    id: index,
    patch: [...header, hunk.header, ...hunk.lines, ''].join('\n'),
  }));
}

async function applyPatch(repo, patch, args) {
  await git(repo, ['apply', '--whitespace=nowarn', ...args, '-'], { input: patch });
}

async function stageFile(repo, filePath) {
  await git(repo, ['add', '--', filePath]);
}

async function unstageFile(repo, filePath) {
  await git(repo, ['restore', '--staged', '--', filePath]);
}

async function discardFile(repo, filePath) {
  const state = await getState(repo);
  const file = state.changes.find((item) => item.path === filePath);
  if (!file) return;

  if (file.untracked) {
    const target = path.resolve(repo, filePath);
    if (!target.startsWith(`${path.resolve(repo)}${path.sep}`)) {
      throw new GitError('Refusing to remove a path outside the repository.');
    }
    await fs.rm(target, { recursive: true, force: false });
    return;
  }

  await git(repo, ['restore', '--worktree', '--', filePath]);
}

async function stageHunk(repo, patch) {
  await applyPatch(repo, patch, ['--cached']);
}

async function unstageHunk(repo, patch) {
  await applyPatch(repo, patch, ['--cached', '--reverse']);
}

async function discardHunk(repo, patch) {
  await applyPatch(repo, patch, ['--reverse']);
}

function buildPartialPatch(patch, selectedIndexes) {
  const lines = patch.split('\n');
  const hunkIndex = lines.findIndex((line) => line.startsWith('@@ '));
  if (hunkIndex < 0) throw new GitError('The selected patch has no hunk.');
  const match = lines[hunkIndex].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!match) throw new GitError('The selected hunk header is invalid.');

  const selected = new Set(selectedIndexes.map(Number));
  const source = lines.slice(hunkIndex + 1);
  while (source.at(-1) === '') source.pop();
  const body = [];
  for (let index = 0; index < source.length;) {
    if (!['+', '-'].includes(source[index][0])) {
      body.push(source[index]);
      index += 1;
      continue;
    }

    const removed = [];
    const added = [];
    while (index < source.length && ['+', '-'].includes(source[index][0])) {
      const item = { line: source[index], index, selected: selected.has(index) };
      if (source[index][0] === '-') removed.push(item);
      else added.push(item);
      index += 1;
    }

    const length = Math.max(removed.length, added.length);
    for (let pair = 0; pair < length; pair += 1) {
      const deletion = removed[pair];
      const addition = added[pair];
      if (deletion) body.push(deletion.selected ? deletion.line : ` ${deletion.line.slice(1)}`);
      if (addition?.selected) body.push(addition.line);
    }
  }

  if (!body.some((line) => line.startsWith('+') || line.startsWith('-'))) {
    throw new GitError('Select at least one changed line.');
  }
  const oldCount = body.filter((line) => line[0] !== '+').length;
  const newCount = body.filter((line) => line[0] !== '-').length;
  const oldStart = Number(match[1]);
  const hunkHeader = `@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@${match[5] || ''}`;
  return [...lines.slice(0, hunkIndex), hunkHeader, ...body, ''].join('\n');
}

async function stageSelectedLines(repo, patch, selectedIndexes, section) {
  const partial = buildPartialPatch(patch, selectedIndexes);
  const args = ['--cached'];
  if (section === 'staged') args.push('--reverse');
  await applyPatch(repo, partial, args);
}

async function commit(repo, message, amend = false) {
  const trimmed = message.trim();
  if (!trimmed && !amend) throw new GitError('Enter a commit message first.');
  const args = ['commit'];
  if (amend) args.push('--amend');
  if (trimmed) args.push('-m', trimmed);
  else args.push('--no-edit');
  await git(repo, args);
  return (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim();
}

async function getHistory(repo, limit = 200) {
  const format = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%D', '%s'].join('%x1f') + '%x1e';
  const raw = await git(repo, ['log', '--all', '--topo-order', `--max-count=${Math.min(Math.max(limit, 1), 500)}`, `--pretty=format:${format}`]).catch(() => '');
  return raw.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [hash, shortHash, parents, author, email, date, refs, subject] = record.split('\x1f');
    return { hash, shortHash, parents: parents ? parents.split(' ') : [], author, email, date, refs: refs ? refs.split(', ').filter(Boolean) : [], subject };
  });
}

async function getCommitDetails(repo, hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new GitError('Invalid commit identifier.');
  const [metadata, patch] = await Promise.all([
    git(repo, ['show', '-s', '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%B', hash]),
    git(repo, ['show', '--format=', '--no-ext-diff', '--no-color', '--find-renames', '--unified=3', hash]),
  ]);
  const [fullHash, shortHash, parents, author, email, date, refs, ...message] = metadata.trim().split('\x1f');
  return { hash: fullHash, shortHash, parents: parents ? parents.split(' ') : [], author, email, date, refs, message: message.join('\x1f').trim(), patch };
}

async function getRemotes(repo) {
  const raw = await git(repo, ['remote', '-v']);
  const map = new Map();
  raw.trim().split('\n').filter(Boolean).forEach((line) => {
    const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/);
    if (!match) return;
    const remote = map.get(match[1]) || { name: match[1], fetchUrl: '', pushUrl: '' };
    remote[match[3] === 'fetch' ? 'fetchUrl' : 'pushUrl'] = match[2];
    map.set(match[1], remote);
  });
  return [...map.values()];
}

async function addRemote(repo, name, url) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new GitError('Invalid remote name.');
  if (!url.trim()) throw new GitError('Enter a remote URL.');
  await git(repo, ['remote', 'add', name, url.trim()]);
}

async function removeRemote(repo, name) {
  await git(repo, ['remote', 'remove', name]);
}

async function fetchRemote(repo) {
  await git(repo, ['fetch', '--all', '--prune']);
}

async function pull(repo) {
  await git(repo, ['pull', '--ff-only']);
}

async function push(repo) {
  const state = await getState(repo);
  const args = ['push'];
  if (!state.upstream) {
    const remotes = await getRemotes(repo);
    if (remotes.length !== 1) throw new GitError('Choose or add exactly one remote before publishing this branch.');
    args.push('--set-upstream', remotes[0].name, state.branch);
  }
  await git(repo, args);
}

async function undoLastCommit(repo, keepStaged = true) {
  const count = Number((await git(repo, ['rev-list', '--count', 'HEAD'])).trim());
  if (count < 2) throw new GitError('The initial commit cannot be undone.');
  const subject = (await git(repo, ['show', '-s', '--format=%h %s', 'HEAD'])).trim();
  await git(repo, ['reset', keepStaged ? '--soft' : '--mixed', 'HEAD~1']);
  return subject;
}

async function getBranches(repo) {
  const raw = await git(repo, ['for-each-ref', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)', 'refs/heads']);
  return raw.split('\n').filter((line) => line.length > 0).map((line) => {
    const [name, current = '', upstream = ''] = line.split('\t');
    return { name, current: current.trim() === '*', upstream: upstream || null };
  });
}

async function switchBranch(repo, name) {
  if (!name || name.startsWith('-')) throw new GitError('Invalid branch name.');
  await git(repo, ['switch', name]);
}

async function createBranch(repo, name) {
  if (!name || name.startsWith('-')) throw new GitError('Invalid branch name.');
  await git(repo, ['check-ref-format', '--branch', name]);
  await git(repo, ['switch', '-c', name]);
}

module.exports = {
  GitError,
  resolveRepository,
  getRepositoryIdentity,
  parseStatus,
  getState,
  getDiff,
  extractHunks,
  stageFile,
  unstageFile,
  discardFile,
  stageHunk,
  unstageHunk,
  discardHunk,
  buildPartialPatch,
  stageSelectedLines,
  commit,
  getHistory,
  getCommitDetails,
  getRemotes,
  addRemote,
  removeRemote,
  fetchRemote,
  pull,
  push,
  undoLastCommit,
  getBranches,
  switchBranch,
  createBranch,
};
