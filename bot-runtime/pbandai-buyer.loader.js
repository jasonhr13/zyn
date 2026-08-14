// Packed builds spawn THIS instead of the plaintext .mjs. It just loads the bundled,
// minified CommonJS engine. process.argv is preserved, so the engine reads
// --monitor/--codes/--id/--config/... exactly as before.
// (No bytenode: V8 bytecode breaks Playwright's page.evaluate — see scripts/build-engine.js.)
require('./pbandai-buyer.cjs');
