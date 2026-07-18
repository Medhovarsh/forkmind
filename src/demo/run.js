const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { execFile } = require('child_process');
const { initStorage } = require('../storage/engine');
const { seed } = require('./seed');

const OLLAMA_TAGS = 'http://localhost:11434/api/tags';

/**
 * Is a local Ollama answering? Any failure (refused, timeout, bad response)
 * means "no" — the demo must never crash because of the probe.
 */
async function probeOllama(timeoutMs = 1000) {
  try {
    const res = await axios.get(OLLAMA_TAGS, { timeout: timeoutMs });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Best-effort browser open; failure is silent (headless machines, CI). */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd built-in; the empty string is the window title slot.
      execFile('cmd', ['/c', 'start', '', url]).on('error', () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [url]).on('error', () => {});
    } else {
      execFile('xdg-open', [url]).on('error', () => {});
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * `forkmind demo` — seed a sample DAG in a throwaway temp workspace and start
 * the normal server against it. The user's own .forkmind/ is never touched:
 * storage resolves paths from process.cwd(), and we chdir into the temp dir.
 */
async function runDemo() {
  const demoDir = path.join(os.tmpdir(), 'forkmind-demo');
  fs.removeSync(demoDir); // always start from a fresh, known dataset
  fs.ensureDirSync(demoDir);
  process.chdir(demoDir);

  initStorage();
  const seeded = seed();

  const live = await probeOllama();
  process.env.FORKMIND_DEMO = '1';
  process.env.FORKMIND_DEMO_LIVE = live ? '1' : '0';

  console.log('\n  DEMO MODE — sample data, nothing saved to your project');
  console.log(`  Seeded ${seeded.nodes} nodes + 1 capsule in ${demoDir}`);
  console.log(
    live
      ? '  Ollama detected → live forking enabled'
      : '  Ollama not detected → forking disabled (install Ollama for live forks)'
  );

  // Required lazily so tests can stub the server without booting express.
  const { startServer, PORT } = require('../proxy/server');
  startServer();
  openBrowser(`http://localhost:${PORT}`);
}

module.exports = { runDemo, probeOllama, openBrowser };
