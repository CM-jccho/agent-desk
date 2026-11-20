import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const share = dirname(fileURLToPath(import.meta.url));
const source = dirname(share);
const dist = resolve(process.argv[2] || join(share, 'dist'));
const scratch = await mkdtemp(join(tmpdir(), 'agent-desk-release-'));
const bundle = join(scratch, 'agent-desk');
const launcher = 'Start Agent Desk.command';
const appFiles = [
  launcher, 'README.md', 'package.json', 'engines.mjs', 'server.mjs', 'service.mjs', 'store.mjs',
  'public/index.html', 'public/desk.css', 'public/desk.js', 'public/mark.svg', 'tests/service.test.mjs', 'tests/launcher.test.mjs',
];

try {
  for (const file of appFiles) {
    await mkdir(dirname(join(bundle, file)), { recursive: true });
    await copyFile(join(source, file), join(bundle, file));
  }
  await chmod(join(bundle, launcher), 0o755);
  await mkdir(join(dist, 'download'), { recursive: true });
  for (const file of ['index.html', 'release.css', 'workspace.png']) {
    await copyFile(join(share, file), join(dist, file));
  }
  await copyFile(join(source, 'public/mark.svg'), join(dist, 'mark.svg'));
  const archive = join(scratch, 'agent-desk.zip');
  execFileSync('zip', ['-q', '-X', '-r', archive, 'agent-desk'], { cwd: scratch });
  await copyFile(archive, join(dist, 'download/agent-desk.zip'));
  console.log('Agent Desk release: ' + dist);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
