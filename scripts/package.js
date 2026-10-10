const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
const outputDirectory = path.join(root, 'dist');
const outputFile = path.join(outputDirectory, `${manifest.name}-${manifest.version}.vsix`);
const vsceBinary = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'vsce.cmd')
  : path.join(root, 'node_modules', '.bin', 'vsce');
const args = ['package', '--allow-missing-repository', '--out', outputFile];

if (process.argv.includes('--pre-release')) {
  args.push('--pre-release');
}

fs.mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync(vsceBinary, args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) {
  throw result.error;
}

process.exit(result.status === null ? 1 : result.status);
