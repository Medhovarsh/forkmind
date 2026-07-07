const path = require('path');
const fs = require('fs-extra');

/**
 * RAID for capsules — Redundant Array of Independent DAGs.
 *
 * Replicates capsule directories (ciphertext + manifest ONLY — key material
 * lives outside .forkmind/ and is NEVER replicated) to any number of extra
 * filesystem targets: another disk, a synced folder (Dropbox/OneDrive), a
 * network mount. If the primary copy is lost or corrupted, the engine heals
 * it back from the first replica whose content survives verification.
 *
 * Config: .forkmind/replicas.json → { "targets": ["D:\\backup\\forkmind", ...] }
 * Replica layout mirrors the primary: <target>/<capsule-id>/manifest.json + seg-*.enc
 *
 * All functions take explicit paths — this module knows nothing about the
 * engine, so the dependency stays one-way (engine → replicas).
 */

function configPath() {
  return path.join(process.cwd(), '.forkmind', 'replicas.json');
}

/** @returns {{targets: string[]}} */
function readConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return { targets: [] };
  const cfg = fs.readJsonSync(p);
  return { targets: Array.isArray(cfg.targets) ? cfg.targets : [] };
}

function writeConfig(cfg) {
  fs.ensureDirSync(path.dirname(configPath()));
  fs.writeJsonSync(configPath(), cfg, { spaces: 2 });
}

/** Add a replica target (created if missing). Returns the updated target list. */
function addTarget(target) {
  const abs = path.resolve(target);
  const primary = path.join(process.cwd(), '.forkmind', 'contexts');
  if (abs === primary) throw new Error('replica target cannot be the primary store');
  fs.ensureDirSync(abs);
  const cfg = readConfig();
  if (!cfg.targets.includes(abs)) {
    cfg.targets.push(abs);
    writeConfig(cfg);
  }
  return cfg.targets;
}

/** Remove a replica target from the config (files are left in place). */
function removeTarget(target) {
  const abs = path.resolve(target);
  const cfg = readConfig();
  cfg.targets = cfg.targets.filter((t) => t !== abs);
  writeConfig(cfg);
  return cfg.targets;
}

/**
 * Copy one capsule dir to every configured target. Best-effort: a dead mount
 * must never fail a save, so per-target errors are reported, not thrown.
 * @returns {{replicated: string[], failed: Array<{target: string, error: string}>}}
 */
function replicate(contextsDir, id) {
  const src = path.join(contextsDir, id);
  const out = { replicated: [], failed: [] };
  if (!fs.existsSync(src)) return out;
  for (const target of readConfig().targets) {
    try {
      fs.copySync(src, path.join(target, id), { overwrite: false, errorOnExist: false });
      out.replicated.push(target);
    } catch (err) {
      out.failed.push({ target, error: err.message });
    }
  }
  return out;
}

/**
 * Restore a capsule dir from the first replica that has it, then let the
 * caller re-verify. Removes any half-broken primary copy first.
 * @returns {string|null} the target healed from, or null if no replica has it.
 */
function heal(contextsDir, id) {
  for (const target of readConfig().targets) {
    const src = path.join(target, id);
    if (!fs.existsSync(path.join(src, 'manifest.json'))) continue;
    const dst = path.join(contextsDir, id);
    fs.removeSync(dst);
    fs.copySync(src, dst);
    return target;
  }
  return null;
}

/**
 * Forgetting must reach every copy: remove the capsule dir from all targets.
 * Key destruction (in the engine) already makes stragglers unreadable, but
 * ciphertext should not outlive intent where we can help it.
 * @returns {{shredded: string[], failed: Array<{target: string, error: string}>}}
 */
function shredEverywhere(id) {
  const out = { shredded: [], failed: [] };
  for (const target of readConfig().targets) {
    try {
      fs.removeSync(path.join(target, id));
      out.shredded.push(target);
    } catch (err) {
      out.failed.push({ target, error: err.message });
    }
  }
  return out;
}

/**
 * Push every primary capsule to every target (catch-up after adding a target
 * or after a mount was offline), and propagate tombstones: any capsule
 * forgotten while a replica was unreachable gets shredded there now, so
 * ciphertext never outlives intent just because a disk was unplugged.
 * @returns {{targets: number, capsules: number, copied: number, failed: number, shredded: number}}
 */
function syncAll(contextsDir) {
  const ids = fs.existsSync(contextsDir)
    ? fs.readdirSync(contextsDir).filter((d) => !d.includes('.tmp-'))
    : [];
  let copied = 0;
  let failed = 0;
  for (const id of ids) {
    const r = replicate(contextsDir, id);
    copied += r.replicated.length;
    failed += r.failed.length;
  }

  // Tombstone propagation.
  let shredded = 0;
  const tombPath = path.join(path.dirname(contextsDir), 'tombstones.json');
  const forgotten = fs.existsSync(tombPath) ? fs.readJsonSync(tombPath).forgotten || [] : [];
  for (const id of forgotten) {
    for (const target of readConfig().targets) {
      const dir = path.join(target, id);
      if (fs.existsSync(dir)) {
        try {
          fs.removeSync(dir);
          shredded++;
        } catch {
          failed++;
        }
      }
    }
  }

  return { targets: readConfig().targets.length, capsules: ids.length, copied, failed, shredded };
}

/**
 * Per-target health: reachable? how many capsules present vs primary?
 * @returns {Array<{target: string, reachable: boolean, capsules: number, missing: number}>}
 */
function status(contextsDir) {
  const primaryIds = fs.existsSync(contextsDir)
    ? fs.readdirSync(contextsDir).filter((d) => !d.includes('.tmp-'))
    : [];
  return readConfig().targets.map((target) => {
    if (!fs.existsSync(target)) {
      return { target, reachable: false, capsules: 0, missing: primaryIds.length };
    }
    const present = primaryIds.filter((id) =>
      fs.existsSync(path.join(target, id, 'manifest.json'))
    );
    return {
      target,
      reachable: true,
      capsules: present.length,
      missing: primaryIds.length - present.length,
    };
  });
}

module.exports = {
  readConfig,
  addTarget,
  removeTarget,
  replicate,
  heal,
  shredEverywhere,
  syncAll,
  status,
};
