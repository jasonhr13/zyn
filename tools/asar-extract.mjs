#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function readArchive(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, prefix.length, 0);

  const headerSize = prefix.readUInt32LE(4);
  const jsonSize = prefix.readUInt32LE(12);
  const header = Buffer.alloc(jsonSize);
  fs.readSync(fd, header, 0, header.length, 16);

  return {
    fd,
    baseOffset: 8 + headerSize,
    tree: JSON.parse(header.toString('utf8')),
  };
}

function visitFiles(node, parts = []) {
  const entries = [];
  for (const [name, child] of Object.entries(node.files || {})) {
    const childParts = [...parts, name];
    if (child.files) entries.push(...visitFiles(child, childParts));
    else entries.push({ parts: childParts, metadata: child });
  }
  return entries;
}

function main() {
  const [archivePath, outputPath] = process.argv.slice(2);
  if (!archivePath || !outputPath) {
    console.error('Usage: asar-extract.mjs ARCHIVE OUTPUT_DIRECTORY');
    process.exit(2);
  }

  const archive = readArchive(archivePath);
  const unpackedRoot = `${archivePath}.unpacked`;

  try {
    for (const { parts, metadata } of visitFiles(archive.tree)) {
      const relativePath = path.join(...parts);
      const destination = path.join(outputPath, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });

      if (metadata.link) {
        fs.symlinkSync(metadata.link, destination);
        continue;
      }

      if (metadata.unpacked) {
        fs.copyFileSync(path.join(unpackedRoot, relativePath), destination);
        continue;
      }

      const data = Buffer.alloc(metadata.size);
      fs.readSync(
        archive.fd,
        data,
        0,
        data.length,
        archive.baseOffset + Number(metadata.offset || 0),
      );
      fs.writeFileSync(destination, data);
      if (metadata.executable) fs.chmodSync(destination, 0o755);
    }
  } finally {
    fs.closeSync(archive.fd);
  }
}

main();
