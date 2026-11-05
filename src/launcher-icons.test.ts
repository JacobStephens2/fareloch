// @vitest-environment node
import { expect, it } from 'vitest';
import { createCanvas, loadImage } from 'canvas';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const densities = [
  ['mdpi', 108],
  ['hdpi', 162],
  ['xhdpi', 216],
  ['xxhdpi', 324],
  ['xxxhdpi', 432],
] as const;

it.each(densities)('keeps the Fareloch mark and macro dots inside launcher masks at %s', async (density, size) => {
  const image = await loadImage(`${root}/android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`);
  const context = createCanvas(image.width, image.height).getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  const colors = { shore: 0, carbs: 0, protein: 0, fat: 0 };
  const clipped = { circle: 0, squircle: 0, safeArea: 0 };
  let foregroundOutsideSafeArea = 0;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (data[i + 3] < 16) continue;
      const dx = (x + 0.5) * 108 / image.width - 54;
      const dy = (y + 0.5) * 108 / image.height - 54;
      const radius = Math.hypot(dx, dy);
      if (radius > 33) foregroundOutsideSafeArea++;
      const [r, g, b] = data.slice(i, i + 3);
      const color = r > 245 && g > 245 && b > 245 ? 'shore'
        : dy < 0 ? null
        : Math.abs(r - 59) + Math.abs(g - 130) + Math.abs(b - 246) < 15 ? 'carbs'
        : Math.abs(r - 239) + Math.abs(g - 68) + Math.abs(b - 68) < 15 ? 'protein'
        : Math.abs(r - 245) + Math.abs(g - 158) + Math.abs(b - 11) < 15 ? 'fat' : null;
      if (!color) continue;
      colors[color]++;
      // Android's 108dp layers have an 18dp overscan border: a 72dp viewport.
      if (radius > 36) clipped.circle++;
      if ((dx / 36) ** 4 + (dy / 36) ** 4 > 1) clipped.squircle++;
      if (radius > 33) clipped.safeArea++;
    }
  }

  for (const [color, count] of Object.entries(colors)) expect(count, `${density}: missing ${color}`).toBeGreaterThan(0);
  expect(clipped, `${density}: artwork clipped by launcher masks`).toEqual({ circle: 0, squircle: 0, safeArea: 0 });
  expect([image.width, image.height]).toEqual([size, size]);
  expect(foregroundOutsideSafeArea, `${density}: foreground needs transparent padding`).toBe(0);
});

it('regenerates the checked-in foregrounds from the logo without changing the Android background', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'fareloch-icons-'));
  const background = 'android/app/src/main/res/drawable/ic_launcher_bg.xml';

  try {
    for (const directory of ['scripts', 'public/app-icons', 'android/app/src/main/res/drawable']) {
      await mkdir(join(stage, directory), { recursive: true });
    }
    for (const file of ['package.json', 'scripts/generate-icons.mjs', 'public/logo.svg', background]) {
      await copyFile(join(root, file), join(stage, file));
    }
    await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'junction');
    const generated = spawnSync(process.execPath, ['scripts/generate-icons.mjs'], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(generated.error).toBeUndefined();
    expect(generated.status, `${generated.stdout}\n${generated.stderr}`).toBe(0);

    const outputs = [background, 'public/favicon.svg'];
    for (const [density] of densities) {
      outputs.push(`android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`);
    }
    for (const file of outputs) {
      expect(await readFile(join(stage, file)), `${file}: regeneration differs`).toEqual(await readFile(join(root, file)));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}, 40_000);
