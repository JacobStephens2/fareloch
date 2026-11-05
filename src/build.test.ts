// @vitest-environment node
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('builds web PWA and native assets without the test runner installed', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const stage = await mkdtemp(join(tmpdir(), 'fareloch-build-'));

  try {
    const configs = (await readdir(root)).filter(name => /^tsconfig.*\.json$/.test(name));
    for (const path of ['src', 'server/src', 'public', 'android', 'capacitor.config.ts', 'package.json', 'vite.config.ts', 'index.html', ...configs]) {
      await cp(join(root, path), join(stage, path), { recursive: true });
    }

    await mkdir(join(stage, 'node_modules'));
    for (const entry of await readdir(join(root, 'node_modules'))) {
      if (entry !== 'vitest') {
        await symlink(join(root, 'node_modules', entry), join(stage, 'node_modules', entry));
      }
    }
    expect(() => createRequire(join(stage, 'package.json')).resolve('vitest')).toThrow();

    const build = spawnSync('npm', ['run', 'build'], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(build.error).toBeUndefined();
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    expect(await readFile(join(stage, 'dist/index.html'), 'utf8')).toContain('manifest.webmanifest');
    expect(await readFile(join(stage, 'dist/index.html'), 'utf8')).not.toContain('registerSW.js');
    expect(await readdir(join(stage, 'dist'))).toContain('sw.js');

    const androidBuild = spawnSync('npm', ['run', 'build:android'], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(androidBuild.error).toBeUndefined();
    expect(androidBuild.status, `${androidBuild.stdout}\n${androidBuild.stderr}`).toBe(0);
    for (const directory of ['dist', 'android/app/src/main/assets/public']) {
      const html = await readFile(join(stage, directory, 'index.html'), 'utf8');
      expect(html).not.toContain('registerSW.js');
      const entries = await readdir(join(stage, directory));
      expect(entries).not.toContain('sw.js');
      expect(entries).not.toContain('registerSW.js');
      expect(entries.some(name => name.startsWith('workbox-'))).toBe(false);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}, 150_000);
