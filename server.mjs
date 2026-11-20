import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDesk } from './service.mjs';

process.umask(0o077);
const directory = process.env.AGENT_DESK_DATA
  ? resolve(process.env.AGENT_DESK_DATA)
  : join(homedir(), process.platform === 'darwin' ? 'Library/Application Support/Agent Desk' : '.local/share/agent-desk');
const port = Number(process.env.AGENT_DESK_PORT || 4877);
const openOnStart = process.platform === 'darwin' && process.argv.includes('--open');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('AGENT_DESK_PORT는 1~65535 사이의 정수여야 합니다.');
}

function openBrowser(url) {
  const browser = spawn('open', [url], { stdio: 'ignore' });
  const help = () => console.error('브라우저에서 직접 이 주소를 여세요. ' + url);
  browser.once('error', help);
  browser.once('exit', (code) => { if (code !== 0) help(); });
}

async function openExistingDesk(url) {
  try {
    const response = await fetch(url + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(1200) });
    if (!response.ok || (await response.json()).app !== 'agent-desk') return false;
    console.log('Agent Desk가 이미 실행 중입니다. ' + url);
    openBrowser(url);
    return true;
  } catch {
    return false;
  }
}

async function start() {
  const url = 'http://127.0.0.1:' + port;
  if (openOnStart && await openExistingDesk(url)) return;
  let desk;
  try {
    desk = await createDesk({ directory, port });
  } catch (error) {
    if (openOnStart && await openExistingDesk(url)) return;
    throw error;
  }
  console.log('Agent Desk: ' + desk.url);
  async function stop() {
    try { await desk.close(); }
    catch (error) {
      console.error('Agent Desk 종료 오류:', error.message);
      process.exitCode = 1;
    }
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (process.platform === 'darwin') process.once('SIGHUP', stop);
  if (openOnStart) openBrowser(desk.url);
}

try {
  await start();
} catch (error) {
  const message = error.code === 'EADDRINUSE' ? '다른 프로그램이 ' + port + '번 포트를 사용 중입니다.' : error.message;
  console.error('Agent Desk 시작 오류:', message);
  process.exitCode = 1;
}
