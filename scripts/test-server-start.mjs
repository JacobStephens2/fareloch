import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../server/', import.meta.url));
const stage = await mkdtemp(join(tmpdir(), 'fareloch-server-start-'));
let child;
let stopped;
let output = '';

try {
  // Keep the real entry point and dependencies, with a disposable database.
  await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
  await cp(join(root, 'package.json'), join(stage, 'package.json'));
  await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir');

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  child = spawn(process.execPath, ['--trace-deprecation', 'dist/index.js'], {
    cwd: stage,
    env: { ...process.env, PORT: String(port), JWT_SECRET: 'startup-smoke-test-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stopped = once(child, 'close');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, `Server exited during startup:\n${output}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      break;
    } catch {
      await delay(100);
    }
  }

  assert.ok(response, `Server did not become healthy:\n${output}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.doesNotMatch(output, /DeprecationWarning|\[DEP\d+\]/);
  console.log(`PASS ${process.version}: compiled server starts, /api/health returns 200, no deprecation warnings`);
} finally {
  if (child) {
    child.kill('SIGKILL');
    await stopped;
  }
  await rm(stage, { recursive: true, force: true });
}
