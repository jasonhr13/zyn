#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const iconset = path.join(projectRoot, 'assets', 'brand', 'Zyn.iconset');
const output = path.join(projectRoot, 'assets', 'brand', 'Zyn.ico');
const images = [16, 32, 128, 256].map(size => ({
  size,
  body: fs.readFileSync(path.join(iconset, `icon_${size}x${size}.png`)),
}));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

let offset = header.length + images.length * 16;
const entries = images.map(({ size, body }) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0);
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(body.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += body.length;
  return entry;
});

fs.writeFileSync(output, Buffer.concat([header, ...entries, ...images.map(image => image.body)]), {
  mode: 0o644,
});
console.log(output);
