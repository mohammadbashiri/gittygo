const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const git = require('./git-service.cjs');
async function command(root, args) {
  try { return (await run('git', ['-C', root, ...args], { maxBuffer: 20 * 1024 * 1024 })).stdout; }
  catch (e) { throw new Error(e.stderr?.trim() || e.message); }
}
async function list(root, { status = true } = {}) {
  const identity = await git.getRepositoryIdentity(root);
  const raw = await command(root, ['worktree', 'list', '--porcelain', '-z']);
  const records = []; let item;
  for (const field of raw.split('\0')) {
    if (field.startsWith('worktree ')) { item = { path: field.slice(9), main: records.length === 0 }; records.push(item); }
    else if (item && field) { const space = field.indexOf(' '); item[space < 0 ? field : field.slice(0, space)] = space < 0 ? true : field.slice(space + 1); }
  }
  if (records.length > 128) throw new Error('Repository has too many worktrees (limit 128).');
  return Promise.all(records.map(async (record) => {
    const result = { path: record.path, main: record.main, branch: record.branch?.replace(/^refs\/heads\//, '') || null, head: record.HEAD || '', detached: !!record.detached, locked: !!record.locked, lockReason: typeof record.locked === 'string' ? record.locked : '', prunable: !!record.prunable, valid: false };
    try {
      const target = await git.getRepositoryIdentity(record.path);
      if (target.gitCommonDirectory !== identity.gitCommonDirectory) return result;
      result.path = target.worktreeRoot; result.valid = true;
      if (!status) return result;
      const state = await git.getState(result.path);
      result.staged = state.staged.length; result.changes = state.changes.length; result.dirty = !!(result.staged || result.changes || state.operation);
    } catch { /* Missing/prunable worktrees remain visible but cannot be opened. */ }
    return result;
  }));
}
async function member(root, target, { status = true } = {}) {
  const found = (await list(root, { status })).find((entry) => entry.path === target);
  if (!found || !found.valid || found.prunable) throw new Error('This worktree is unavailable or no longer belongs to this repository.');
  return found;
}
async function fingerprint(root) {
  const entries = await list(root);
  const values = await Promise.all(entries.map(async (entry) => [entry, entry.valid ? await git.getRepositoryMutationFingerprint(entry.path) : null]));
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
async function create(root, folder, branch, newBranch) {
  if (typeof folder !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(folder) || folder === '.' || folder === '..') throw new Error('Use a simple sibling folder name (letters, numbers, dots, dashes).');
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('Enter a branch name.');
  await command(root, ['check-ref-format', '--branch', branch]);
  const target = path.join(path.dirname(root), folder);
  if (await fs.lstat(target).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; })) throw new Error('That sibling folder already exists. Choose a new folder name.');
  const entries = await list(root);
  if (entries.some((e) => e.branch === branch)) throw new Error('That branch already has a worktree. View it instead.');
  if (!newBranch) await command(root, ['show-ref', '--verify', `refs/heads/${branch}`]);
  await command(root, ['worktree', 'add', ...(newBranch ? ['-b', branch] : []), target, ...(newBranch ? [] : [branch])]);
  return { path: await fs.realpath(target), branch };
}
async function activeViews(root, target) {
  const identity = await git.getRepositoryIdentity(root);
  const directory = path.join(identity.gitCommonDirectory, 'gittygo-active-views');
  const names = await fs.readdir(directory).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  if (names.length > 1024) throw new Error('Too many active-view records; removal is disabled until reviewed manually.');
  for (const name of names) {
    if (!/^[a-f0-9]{48}\.json$/.test(name)) throw new Error('Unrecognized active-view record; removal is disabled.');
    let record;
    try { record = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') continue; throw new Error('Unreadable active-view record; removal is disabled.'); }
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !Array.isArray(record.roots)) throw new Error('Invalid active-view record; removal is disabled.');
    if (!record.roots.includes(target)) continue;
    try { process.kill(record.pid, 0); return true; }
    catch (e) { if (e.code !== 'ESRCH') return true; }
  }
  return false;
}
async function createViewLease(root, roots) {
  const identity = await git.getRepositoryIdentity(root);
  const directory = path.join(identity.gitCommonDirectory, 'gittygo-active-views');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Invalid active-view directory.');
  const filename = path.join(directory, `${crypto.randomBytes(24).toString('hex')}.json`);
  const update = (values) => fs.writeFile(filename, JSON.stringify({ pid: process.pid, roots: values }), { mode: 0o600 });
  await update(roots);
  return { update, close: () => fs.unlink(filename).catch((e) => { if (e.code !== 'ENOENT') throw e; }) };
}
async function remove(root, target, protectedRoots) {
  const entry = await member(root, target);
  if (entry.main || protectedRoots.includes(entry.path)) throw new Error('The main, invoking, or currently viewed worktree cannot be removed.');
  if (await activeViews(root, target)) throw new Error('This worktree is open in another GittyGo view. Close that view before removing it.');
  if (entry.dirty || entry.locked || entry.prunable) throw new Error('Only clean, unlocked, available worktrees can be removed. Resolve its changes or lock in Git first.');
  await command(root, ['worktree', 'remove', entry.path]);
  return { path: entry.path };
}
module.exports = { list, member, fingerprint, create, remove, command, createViewLease, activeViews };
