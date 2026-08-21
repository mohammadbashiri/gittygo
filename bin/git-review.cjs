#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const electron = require('electron');
const args = process.argv.slice(2);
const repoArgument = args.find((argument) => !argument.startsWith('-'));
const repo = path.resolve(repoArgument || process.cwd());
const wait = args.includes('--wait');

const child = spawn(electron, [projectRoot, '--', repo], {
  detached: !wait,
  stdio: wait ? 'inherit' : 'ignore',
});

if (wait) {
  child.on('exit', (code) => process.exit(code || 0));
} else {
  child.unref();
  process.stdout.write(`${JSON.stringify({ status: 'opened', repo })}\n`);
}
