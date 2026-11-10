// Shared proposed text, not shared mutable editor state. One atomic record per
// canonical worktree identity; readers never consume/delete another view's copy.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stateRoot } = require('./state-root.cjs');
const gitService = require('./git-service.cjs');
const MAX_BYTES = 160 * 1024;

async function proposalFile(identity) {
  const directory = path.join(stateRoot(), 'commit-proposals');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe commit-proposal directory.');
  await fs.chmod(directory, 0o700);
  return path.join(directory, identity.repoIdentity + '.json');
}
async function writeProposal(directory, message) {
  if (typeof message !== 'string' || message.length > 20000) throw new Error('Commit message must be text of at most 20000 characters.');
  const identity = await gitService.getRepositoryIdentity(directory);
  const state = await gitService.getCommitIdentity(identity.worktreeRoot);
  const record = { version: 1, proposalId: crypto.randomUUID(), worktreeRoot: identity.worktreeRoot, repoIdentity: identity.repoIdentity,
    baseHead: state.head || null, baseBranch: state.branch || null, message,
    requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
  const file = await proposalFile(identity), temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  return record;
}
async function readProposal(directory, knownIdentity) {
  const identity = knownIdentity || await gitService.getRepositoryIdentity(directory);
  if (knownIdentity && identity.worktreeRoot !== directory) throw new Error('Commit-proposal worktree binding changed.');
  const file = await proposalFile(identity);
  let handle, record;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES || info.mode & 0o077) throw new Error('Unsafe commit-proposal file.');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0;
    while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > MAX_BYTES) throw new Error('Commit proposal is too large.');
    record = JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
  if (record?.version !== 1 || !/^[a-f0-9-]{36}$/.test(record.proposalId || '') || record.worktreeRoot !== identity.worktreeRoot || record.repoIdentity !== identity.repoIdentity ||
      typeof record.message !== 'string' || record.message.length > 20000 || !Number.isFinite(Date.parse(record.expiresAt))) throw new Error('Invalid commit proposal.');
  if (Date.parse(record.expiresAt) < Date.now()) return null;
  const state = await gitService.getCommitIdentity(identity.worktreeRoot);
  if (record.baseHead !== (state.head || null) || record.baseBranch !== (state.branch || null)) return null;
  return record;
}
module.exports = { writeProposal, readProposal };
