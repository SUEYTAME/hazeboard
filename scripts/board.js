#!/usr/bin/env node
// Thin wrapper so `npm run board -- add "..."` reaches the Electron main process.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const root = path.join(__dirname, '..');
const child = spawn(electron, [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));
