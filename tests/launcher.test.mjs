import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../Start Agent Desk.command', import.meta.url));

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('the macOS launcher opens the local site from another folder and reuses its running instance', { skip: process.platform !== 'darwin' }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'agent desk launch '));
  const bin = join(tmp, 'bin');
  const receipt = join(tmp, 'browser.log');
  await mkdir(bin);
  await writeFile(join(bin, 'open'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$LAUNCH_RECEIPT"\n', { mode: 0o700 });
  const port = await unusedPort();
  const url = 'http://127.0.0.1:' + port;
  const env = {
    ...process.env, PATH: bin + ':' + process.env.PATH,
    AGENT_DESK_PORT: String(port), AGENT_DESK_DATA: join(tmp, 'data'),
    LAUNCH_RECEIPT: receipt,
  };
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'close');
        child.kill('SIGTERM');
        await done;
      }
    }
    await rm(tmp, { recursive: true, force: true });
  });
  function start() {
    const child = spawn(launcher, [], { cwd: tmp, env, stdio: 'ignore' });
    children.push(child);
    return child;
  }
  const first = start();
  const ready = once(first, 'spawn');
  await ready;
  for (let tries = 0; tries < 100; tries++) {
    const opened = await readFile(receipt, 'utf8').catch(() => '');
    if (opened.trim() === url) break;
    if (tries === 99) assert.fail('The first launch did not open the browser');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(await (await fetch(url + '/api/health')).json(), { app: 'agent-desk' });
  const second = start();
  const [code] = await once(second, 'close');
  assert.equal(code, 0);
  assert.equal(first.exitCode, null);
  assert.deepEqual((await readFile(receipt, 'utf8')).trim().split('\n'), [url, url]);

  const stopped = once(first, 'close');
  first.kill('SIGHUP');
  const [exitCode] = await stopped;
  assert.equal(exitCode, 0);
  await assert.rejects(fetch(url + '/api/health'));
});
