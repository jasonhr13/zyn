const fs = require('fs');
const path = require('path');

// Throwaway Chromium cache subdirs inside a persistent profile. Deleting these reclaims almost all
// of a profile's disk footprint and Chromium simply rebuilds them on next launch. We NEVER touch the
// session (Cookies), Local Storage, Login Data, or Preferences — so clearing these logs no one out.
const CACHE_SUBDIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/ScriptCache',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'Default/DawnCache',
];

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) stack.push(fp);
      else { try { total += fs.statSync(fp).size; } catch {} }
    }
  }
  return total;
}

// Clear cache from every pbandai-profile-* under dataDir. Skips any profile id in skipIds (i.e.
// currently running — its browser holds file locks). Cache-only: never removes a whole profile and
// never removes a login. Fully guarded so a locked file can't throw. Returns { freed, profiles }.
function sweepPbandaiCache(dataDir, skipIds = []) {
  const skip = new Set(skipIds.map(String));
  let freed = 0;
  let profiles = 0;
  let ents;
  try { ents = fs.readdirSync(dataDir, { withFileTypes: true }); } catch { return { freed: 0, profiles: 0 }; }
  for (const e of ents) {
    if (!e.isDirectory() || !e.name.startsWith('pbandai-profile-')) continue;
    const id = e.name.slice('pbandai-profile-'.length);
    if (skip.has(id)) continue;
    profiles++;
    for (const sub of CACHE_SUBDIRS) {
      const fp = path.join(dataDir, e.name, sub);
      if (!fs.existsSync(fp)) continue;
      const sz = dirSize(fp);
      try { fs.rmSync(fp, { recursive: true, force: true }); freed += sz; } catch {}
    }
  }
  return { freed, profiles };
}

module.exports = { sweepPbandaiCache, CACHE_SUBDIRS };
