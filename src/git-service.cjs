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
  return path.resolve(root);
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
  const [rawStatus, branch, head] = await Promise.all([
    git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(repo, ['branch', '--show-current']),
    git(repo, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
  ]);

  const files = parseStatus(rawStatus);
  const staged = files
    .filter((file) => file.staged)
    .map((file) => ({ ...file, section: 'staged', status: displayStatus(file, true) }));
  const changes = files
    .filter((file) => file.unstaged)
    .map((file) => ({ ...file, section: 'unstaged', status: displayStatus(file, false) }));

  return {
    repo,
    name: path.basename(repo),
    branch: branch.trim() || 'detached',
    head: head.trim(),
    staged,
    changes,
  };
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

async function commit(repo, message) {
  const trimmed = message.trim();
  if (!trimmed) throw new GitError('Enter a commit message first.');
  await git(repo, ['commit', '-m', trimmed]);
  return (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim();
}

module.exports = {
  GitError,
  resolveRepository,
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
  commit,
};
