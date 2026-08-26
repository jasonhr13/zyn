'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'launcher', 'node_modules', 'sharp'));

const project = path.join(__dirname, '..');
const sourcePath = path.join(project, 'assets', 'brand', 'zyn-icon.png');
const FILL = { r: 192, g: 1, b: 27 };

async function contentBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a > 8 && (r > 12 || g > 12 || b > 12)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function mark() {
  const box = await contentBox(sourcePath);
  return sharp(sourcePath).extract(box);
}

async function fullBleed(size) {
  const zoom = Math.ceil(size * 1.16);
  const inset = Math.floor((zoom - size) / 2);
  return (await mark())
    .resize(zoom, zoom, { fit: 'cover', position: 'centre' })
    .extract({ left: inset, top: inset, width: size, height: size })
    .flatten({ background: FILL })
    .removeAlpha();
}

async function contained(size, padding = 0.1) {
  const inner = Math.max(1, Math.round(size * (1 - padding * 2)));
  const glyph = await (await mark())
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: glyph, gravity: 'centre' }]);
}

async function writePng(image, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await image.png({ compressionLevel: 9 }).toFile(dest);
  console.log(dest);
}

async function writeWebp(image, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await image.webp({ quality: 92 }).toFile(dest);
  console.log(dest);
}

async function main() {
  const iosIcon = path.join(
    project,
    'mobile/ios/Zyn/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png',
  );
  const expoIcon = path.join(project, 'mobile/assets/icon.png');
  const adaptive = path.join(project, 'mobile/assets/adaptive-icon.png');

  await writePng(await fullBleed(1024), iosIcon);
  await writePng(await fullBleed(1024), expoIcon);
  await writePng(await contained(1024, 0.12), adaptive);

  const mipmap = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
  };
  const foreground = {
    'mipmap-mdpi': 108,
    'mipmap-hdpi': 162,
    'mipmap-xhdpi': 216,
    'mipmap-xxhdpi': 324,
    'mipmap-xxxhdpi': 432,
  };
  const splash = {
    'drawable-mdpi': 288,
    'drawable-hdpi': 432,
    'drawable-xhdpi': 576,
    'drawable-xxhdpi': 864,
    'drawable-xxxhdpi': 1152,
  };
  const res = path.join(project, 'mobile/android/app/src/main/res');

  for (const [folder, size] of Object.entries(mipmap)) {
    const image = await fullBleed(size);
    await writeWebp(image, path.join(res, folder, 'ic_launcher.webp'));
    await writeWebp(image.clone(), path.join(res, folder, 'ic_launcher_round.webp'));
  }
  for (const [folder, size] of Object.entries(foreground)) {
    await writePng(await contained(size, 0.18), path.join(res, folder, 'ic_launcher_foreground.png'));
  }
  for (const [folder, size] of Object.entries(splash)) {
    await writePng(await contained(size, 0.08), path.join(res, folder, 'splashscreen_logo.png'));
  }

  const anydpi = path.join(res, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpi, { recursive: true });
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/iconBackground"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'), adaptiveXml);
  fs.writeFileSync(path.join(anydpi, 'ic_launcher_round.xml'), adaptiveXml);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
