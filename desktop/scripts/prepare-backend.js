const fs = require('fs');
const path = require('path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const backendRoot = path.join(desktopRoot, 'backend');
const REQUIRED_BACKEND_FILES = [
  'desktop-backend.js',
  'package.json',
  'lib/desktop/dm-history.js',
  'lib/desktop/dm-inbox.js',
  'lib/desktop/dm-leads.js',
  'lib/desktop/dm-reply-workflow.js',
  'lib/desktop/dm-work-queue.js',
  'lib/desktop/operation-lease.js',
  'scripts/douyin.user.js',
  'node/node.exe',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/ws/package.json',
];

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (!filter(source, entry)) continue;
    if (entry.isDirectory()) copyDir(source, target, filter);
    else if (entry.isFile()) copyFile(source, target);
  }
}

remove(backendRoot);
fs.mkdirSync(backendRoot, { recursive: true });

copyFile(path.join(repoRoot, 'desktop-backend.js'), path.join(backendRoot, 'desktop-backend.js'));
copyFile(path.join(repoRoot, 'package.json'), path.join(backendRoot, 'package.json'));
copyDir(path.join(repoRoot, 'lib'), path.join(backendRoot, 'lib'));
copyDir(path.join(repoRoot, 'node_modules'), path.join(backendRoot, 'node_modules'), (source, entry) => {
  if (entry.isDirectory() && ['.cache'].includes(entry.name)) return false;
  return true;
});

copyFile(process.execPath, path.join(backendRoot, 'node', 'node.exe'));

copyFile(
  path.join(repoRoot, 'scripts', 'douyin.user.js'),
  path.join(backendRoot, 'scripts', 'douyin.user.js'),
);

for (const name of [
  'reply-strategy.md',
  '\u8bc4\u8bba\u98ce\u683c\u6307\u5357.md',
  '\u8bc4\u8bba\u533a\u8fd0\u8425.md',
  '\u5168\u5c40\u89c4\u5219.md',
]) {
  const source = path.join(repoRoot, name);
  if (fs.existsSync(source)) copyFile(source, path.join(backendRoot, name));
}

const missingFiles = REQUIRED_BACKEND_FILES.filter((relativePath) => (
  !fs.existsSync(path.join(backendRoot, ...relativePath.split('/')))
));
if (missingFiles.length > 0) {
  throw new Error(`Packaged backend is missing required files: ${missingFiles.join(', ')}`);
}

console.log(`[prepare-backend] copied and verified ${REQUIRED_BACKEND_FILES.length} required files in ${backendRoot}`);
