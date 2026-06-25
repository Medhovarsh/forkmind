#!/usr/bin/env node
/**
 * Runs automatically on `npm install` and on git installs
 * (`npm i -g github:<user>/forkmind`). Builds the dashboard so `forkmind start`
 * can serve the UI out of the box.
 *
 * It must NEVER hard-fail an install: if the dashboard toolchain isn't present
 * (e.g. a production-only / --omit=dev install), we skip the build with a note.
 * The proxy + CLI work without the bundled dashboard (use `npm run dashboard:dev`).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dashboard', 'dist');
const viteBin = path.join(root, 'node_modules', 'vite');

// Already built (e.g. from a published tarball that ships dashboard/dist)? Done.
if (fs.existsSync(path.join(dist, 'index.html'))) {
  process.exit(0);
}

// No dashboard toolchain available — skip quietly, don't break the install.
if (!fs.existsSync(viteBin)) {
  console.log('[forkmind] dashboard toolchain not installed; skipping UI build.');
  console.log('[forkmind] proxy + CLI ready. For the UI: npm run dashboard:dev');
  process.exit(0);
}

try {
  console.log('[forkmind] building dashboard…');
  execSync('npm run dashboard:build', { cwd: root, stdio: 'inherit' });
} catch (err) {
  console.log(`[forkmind] dashboard build skipped (${err.message}).`);
  console.log('[forkmind] proxy + CLI still work. UI: npm run dashboard:dev');
}
process.exit(0);
