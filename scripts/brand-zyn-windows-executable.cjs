#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

if (process.platform === 'darwin' && !process.env.WINE_BINARY
  && fs.existsSync('/opt/homebrew/bin/wine')) {
  process.env.WINE_BINARY = '/opt/homebrew/bin/wine';
}
const rcedit = require('../release-tools/node_modules/rcedit');

const executable = process.argv[2] && path.resolve(process.argv[2]);
const version = String(process.argv[3] || '');
const icon = path.resolve(__dirname, '..', 'assets', 'brand', 'Zyn.ico');
if (!executable || !fs.existsSync(executable) || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/brand-zyn-windows-executable.cjs <Zyn.exe> <version>');
  process.exit(2);
}
const windowsVersion = `${version}.0`;

rcedit(executable, {
  'version-string': {
    CompanyName: 'thwebco, LLC',
    FileDescription: 'Zyn',
    InternalName: 'Zyn',
    LegalCopyright: `Copyright © ${new Date().getUTCFullYear()} thwebco, LLC`,
    OriginalFilename: 'Zyn.exe',
    ProductName: 'Zyn',
  },
  'file-version': windowsVersion,
  'product-version': windowsVersion,
  icon,
  'requested-execution-level': 'asInvoker',
}).then(() => console.log(executable)).catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
