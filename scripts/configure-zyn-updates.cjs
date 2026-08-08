const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const config = path.join(projectRoot, 'cloudflare', 'updates', 'wrangler.jsonc');
const keychainAccount = 'zyn-updates';
const keychainService = 'com.thwebco.zyn.r2-upload';
const wrangler = path.join(projectRoot, 'site', 'node_modules', '.bin', 'wrangler');

let token;
try {
  token = execFileSync('security', [
    'find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  token = crypto.randomBytes(32).toString('hex');
}

execFileSync(wrangler, [
  'secret', 'put', 'ZYN_UPLOAD_TOKEN', '--config', config,
], {
  cwd: projectRoot,
  input: `${token}\n`,
  stdio: ['pipe', 'inherit', 'inherit'],
});

execFileSync('security', [
  'add-generic-password', '-U',
  '-a', keychainAccount,
  '-s', keychainService,
  '-w', token,
], { stdio: ['ignore', 'ignore', 'inherit'] });

console.log('Zyn update upload credential is synchronized with Cloudflare and this Mac\'s Keychain.');
