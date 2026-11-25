/**
 * Rasterize public/logo.svg into web + Android launcher icons.
 * Usage: node scripts/generate-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const svgPath = path.join(root, 'public', 'logo.svg');
const svg = fs.readFileSync(svgPath);

// Keep the same mark as the web icon, hiding only its named background.
// A 76dp logo box on a 108dp layer puts the enclosure, F and dots within the central
// 66dp safe circle, with transparent overscan for launcher masks and motion.
const adaptiveSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">
  <style>#background { display: none; }</style>
  <g transform="translate(16 16) scale(${76 / 512})">${svg}</g>
</svg>`);

async function writePng(outPath, size, { flatten = null, source = svg } = {}) {
  let pipeline = sharp(source, { density: 384 }).resize(size, size, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  if (flatten) {
    pipeline = pipeline.flatten({ background: flatten });
  }
  await pipeline.png().toFile(outPath);
  console.log('wrote', path.relative(root, outPath), `(${size}x${size})`);
}

async function main() {
  // Web / PWA
  await writePng(path.join(root, 'public', 'app-icons', 'icon-512.png'), 512);
  await writePng(path.join(root, 'public', 'app-icons', 'icon-192.png'), 192);
  fs.copyFileSync(svgPath, path.join(root, 'public', 'favicon.svg'));
  await writePng(path.join(root, 'public', 'favicon.png'), 32);
  await writePng(path.join(root, 'public', 'favicon-16.png'), 16);
  await writePng(path.join(root, 'public', 'favicon-48.png'), 48);

  // Multi-size ICO (PNG-compressed entries; fine for modern browsers)
  {
    const sizes = [16, 32, 48];
    const images = [];
    for (const size of sizes) {
      const data = await sharp(svg, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      images.push({ size, data });
    }
    const headerSize = 6;
    const entrySize = 16;
    let offset = headerSize + entrySize * images.length;
    const entries = images.map((img) => {
      const e = { ...img, offset };
      offset += img.data.length;
      return e;
    });
    const buf = Buffer.alloc(offset);
    buf.writeUInt16LE(0, 0);
    buf.writeUInt16LE(1, 2);
    buf.writeUInt16LE(images.length, 4);
    entries.forEach((e, i) => {
      const o = headerSize + i * entrySize;
      buf.writeUInt8(e.size >= 256 ? 0 : e.size, o);
      buf.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
      buf.writeUInt8(0, o + 2);
      buf.writeUInt8(0, o + 3);
      buf.writeUInt16LE(1, o + 4);
      buf.writeUInt16LE(32, o + 6);
      buf.writeUInt32LE(e.data.length, o + 8);
      buf.writeUInt32LE(e.offset, o + 12);
      e.data.copy(buf, e.offset);
    });
    const icoPath = path.join(root, 'public', 'favicon.ico');
    fs.writeFileSync(icoPath, buf);
    console.log('wrote', path.relative(root, icoPath), `(${buf.length} bytes)`);
  }

  // Capacitor Android launcher densities (full icon, already rounded in SVG)
  const androidDensities = {
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192,
  };
  for (const [density, size] of Object.entries(androidDensities)) {
    const dir = path.join(root, 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });
    await writePng(path.join(dir, 'ic_launcher.png'), size);
    await writePng(path.join(dir, 'ic_launcher_round.png'), size);
    // Adaptive layers are 108dp, while the legacy launcher icons are 48dp.
    await writePng(path.join(dir, 'ic_launcher_foreground.png'), size * 108 / 48, { source: adaptiveSvg });
  }

  // TWA bubblewrap mipmaps
  const twaDensities = {
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192,
  };
  for (const [density, size] of Object.entries(twaDensities)) {
    const dir = path.join(root, 'android-twa', 'app', 'src', 'main', 'res', `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });
    await writePng(path.join(dir, 'ic_launcher.png'), size);
    await writePng(path.join(dir, 'ic_maskable.png'), size);
  }

  // Adaptive icon background color → deep teal matching the mark
  const bgXml = path.join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'ic_launcher_background.xml');
  if (fs.existsSync(bgXml)) {
    fs.writeFileSync(
      bgXml,
      `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0F766E</color>
</resources>
`
    );
    console.log('updated ic_launcher_background.xml');
  }

  // TWA splash screens (were the old M mark)
  const twaSplash = {
    mdpi: 288,
    hdpi: 288,
    xhdpi: 384,
    xxhdpi: 384,
    xxxhdpi: 512,
  };
  for (const [density, size] of Object.entries(twaSplash)) {
    const dir = path.join(root, 'android-twa', 'app', 'src', 'main', 'res', `drawable-${density}`);
    fs.mkdirSync(dir, { recursive: true });
    await writePng(path.join(dir, 'splash.png'), size);
  }

  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
