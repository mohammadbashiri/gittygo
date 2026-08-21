const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const gitDirectoryCache = new Map();
const commitDetailsCache = new Map();
const MAX_COMMIT_DETAILS_CACHE = 32;

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
  const worktreeVersions = new Map(await Promise.all(files.filter((file) => file.unstaged).map(async (file) => {
    const stat = await fs.stat(path.join(repo, file.path)).catch(() => null);
    return [file.path, stat ? { worktreeMtimeMs: stat.mtimeMs, worktreeCtimeMs: stat.ctimeMs, worktreeSize: stat.size } : { worktreeMissing: true }];
  })));
  const staged = files
    .filter((file) => file.staged)
    .map((file) => ({ ...file, ...(worktreeVersions.get(file.path) || {}), section: 'staged', status: displayStatus(file, true) }));
  const changes = files
    .filter((file) => file.unstaged)
    .map((file) => ({ ...file, ...(worktreeVersions.get(file.path) || {}), section: 'unstaged', status: displayStatus(file, false) }));

  const indexStat = await fs.stat(path.join(gitDirectoryCache.get(repo), 'index')).catch(() => null);
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
    indexMtimeMs: indexStat?.mtimeMs || 0,
    indexSize: indexStat?.size || 0,
    conflicted: files.some((file) => file.indexStatus === 'U' || file.worktreeStatus === 'U' || ['AA', 'DD'].includes(`${file.indexStatus}${file.worktreeStatus}`)),
    staged,
    changes,
  };
}

async function getOperationState(repo) {
  let absoluteGitDir = gitDirectoryCache.get(repo);
  if (!absoluteGitDir) {
    const gitDir = (await git(repo, ['rev-parse', '--git-dir'])).trim();
    absoluteGitDir = path.resolve(repo, gitDir);
    gitDirectoryCache.set(repo, absoluteGitDir);
  }
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

async function stageAll(repo) {
  await git(repo, ['add', '--all']);
}

async function unstageAll(repo) {
  let hasHead = true;
  try { await git(repo, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
  if (hasHead) await git(repo, ['restore', '--staged', '--', '.']);
  else await git(repo, ['rm', '--cached', '--recursive', '--ignore-unmatch', '--', '.']);
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

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_HISTORY_PATCH_BYTES = 2 * 1024 * 1024;

function parseNameStatus(raw) {
  const tokens = raw.split('\0');
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++];
    if (!statusToken) continue;
    const status = statusToken[0];
    if (status === 'R' || status === 'C') {
      files.push({ status, similarity: Number(statusToken.slice(1)) || null, oldPath: tokens[index++], path: tokens[index++] });
    } else files.push({ status, oldPath: null, path: tokens[index++] });
  }
  return files;
}

function parseNumstat(raw) {
  const tokens = raw.split('\0');
  const stats = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++];
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    const additionsValue = token.slice(0, firstTab);
    const deletionsValue = token.slice(firstTab + 1, secondTab);
    const embeddedPath = token.slice(secondTab + 1);
    let oldPath = null;
    let filePath = embeddedPath;
    if (!embeddedPath) {
      oldPath = tokens[index++];
      filePath = tokens[index++];
    }
    stats.push({
      oldPath,
      path: filePath,
      additions: additionsValue === '-' ? null : Number(additionsValue),
      deletions: deletionsValue === '-' ? null : Number(deletionsValue),
      binary: additionsValue === '-' || deletionsValue === '-',
    });
  }
  return stats;
}

async function getCommitDetails(repo, hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new GitError('Invalid commit identifier.');
  const requestedKey = `${repo}\0${hash.toLowerCase()}`;
  if (commitDetailsCache.has(requestedKey)) {
    const cached = commitDetailsCache.get(requestedKey);
    commitDetailsCache.delete(requestedKey); commitDetailsCache.set(requestedKey, cached);
    return cached;
  }
  const metadata = await git(repo, ['show', '-s', '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%B', hash]);
  const [fullHash, shortHash, parentsValue, author, email, date, refsValue, ...message] = metadata.trim().split('\x1f');
  const parents = parentsValue ? parentsValue.split(' ') : [];
  const base = parents[0] || EMPTY_TREE_HASH;
  const diffArgs = ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--find-copies', base, fullHash];
  const [nameStatus, numstat] = await Promise.all([
    git(repo, [...diffArgs.slice(0, -2), '--name-status', '-z', base, fullHash]),
    git(repo, [...diffArgs.slice(0, -2), '--numstat', '-z', base, fullHash]),
  ]);
  const files = parseNameStatus(nameStatus);
  const stats = parseNumstat(numstat);
  files.forEach((file, index) => Object.assign(file, stats[index] || { additions: 0, deletions: 0, binary: false }));
  const totals = files.reduce((result, file) => {
    result.additions += file.additions || 0;
    result.deletions += file.deletions || 0;
    if (file.binary) result.binaries += 1;
    if (file.status === 'R') result.renames += 1;
    return result;
  }, { files: files.length, additions: 0, deletions: 0, binaries: 0, renames: 0 });
  const details = {
    hash: fullHash,
    shortHash,
    parents,
    author,
    email,
    date,
    refs: refsValue ? refsValue.split(', ').filter(Boolean) : [],
    message: message.join('\x1f').trim(),
    comparison: { kind: parents.length === 0 ? 'root' : parents.length > 1 ? 'first-parent' : 'parent', base },
    files,
    totals,
  };
  for (const key of new Set([requestedKey, `${repo}\0${fullHash.toLowerCase()}`, `${repo}\0${shortHash.toLowerCase()}`])) commitDetailsCache.set(key, details);
  while (commitDetailsCache.size > MAX_COMMIT_DETAILS_CACHE) commitDetailsCache.delete(commitDetailsCache.keys().next().value);
  return details;
}

async function getCommitFileDiff(repo, hash, oldPath, filePath) {
  const details = await getCommitDetails(repo, hash);
  const file = details.files.find((item) => item.path === filePath && (item.oldPath || null) === (oldPath || null));
  if (!file) throw new GitError('The selected file does not belong to this commit comparison.');
  if (file.binary) return { patch: '', hunks: [], binary: true, truncated: false, file };
  const paths = [...new Set([file.oldPath, file.path].filter(Boolean))];
  let patch = await git(repo, ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--unified=3', details.comparison.base, details.hash, '--', ...paths]);
  let truncated = false;
  if (Buffer.byteLength(patch) > MAX_HISTORY_PATCH_BYTES) {
    patch = Buffer.from(patch).subarray(0, MAX_HISTORY_PATCH_BYTES).toString('utf8');
    truncated = true;
  }
  return { patch, hunks: extractHunks(patch), binary: false, truncated, file };
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
  stageAll,
  unstageAll,
  discardFile,
  stageHunk,
  unstageHunk,
  discardHunk,
  buildPartialPatch,
  stageSelectedLines,
  commit,
  getHistory,
  getCommitDetails,
  getCommitFileDiff,
  parseNameStatus,
  parseNumstat,
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
