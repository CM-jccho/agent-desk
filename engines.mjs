import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const commands = { codex: 'codex', claude: 'claude' };
const codexLimits = ['--disable', 'shell_tool', '--disable', 'hooks', '--disable', 'plugins',
  '--disable', 'remote_plugin', '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--config', 'web_search="disabled"'];
const claudeLimits = ['--print', '--restricted', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
  '--no-chrome', '--no-session-persistence', '--setting-sources', ''];
export const modelIdPattern = /^[\w][\w./:-]*(?:\[[\w-]+\])?$/;

function engineEnvironment(engine) {
  const env = {};
  for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [...new Set([
    ...(env.PATH || '/usr/bin:/bin').split(':').filter((part) => part.startsWith('/')),
    join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin',
  ])].join(':');
  const profile = engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const configured = process.env['AGENT_DESK_' + profile] || process.env[profile];
  if (configured) env[profile] = configured;
  return env;
}

function invoke(engine, args, { cwd = tmpdir(), input = '', signal, timeout = 8000, protocol } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const binary = commands[engine];
    const child = spawn(binary, args, { cwd, env: engineEnvironment(engine), detached: true, stdio: 'pipe' });
    let stdout = '';
    let bytes = 0;
    let failure;
    let killTimer;
    let doneTimer;
    let reply;

    function kill(signalName) {
      if (!child.pid) return;
      try { process.kill(-child.pid, signalName); }
      catch (error) { if (error.code !== 'ESRCH') console.error('Runner signal:', error.code); }
    }
    function terminate() {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1500);
      killTimer.unref();
    }
    function stop(error) {
      if (failure || reply !== undefined) return;
      failure = error;
      terminate();
    }
    function send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }
    const timer = setTimeout(() => stop(new Error('실행 시간이 초과되었습니다.')), timeout);
    const abort = () => stop(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_000_000) stop(new Error('엔진 출력이 한도를 초과했습니다.'));
      else if (!protocol) stdout += chunk;
    });
    if (protocol) {
      createInterface({ input: child.stdout, terminal: false }).on('line', (line) => {
        if (!line.startsWith('{') || failure || reply !== undefined) return;
        try {
          const result = protocol.receive(JSON.parse(line), send);
          if (result === undefined) return;
          reply = result;
          child.stdin.end();
          doneTimer = setTimeout(terminate, 500);
          doneTimer.unref();
        } catch (error) {
          stop(error);
        }
      });
    }
    // Consume stderr to keep the child from blocking. Provider logs may contain account details.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (error) => { failure ??= error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(doneTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) {
        kill('SIGKILL');
        reject(failure);
      } else resolve({ code, stdout, reply });
    });
    if (protocol) send(protocol.start);
    else child.stdin.end(input);
  });
}

export async function probeEngine(engine) {
  try {
    const args = engine === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
    const { code, stdout } = await invoke(engine, args);
    if (code !== 0) return 'login_required';
    return engine === 'claude' && !JSON.parse(stdout).loggedIn ? 'login_required' : 'ready';
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'unavailable';
  }
}

export async function discoverModels(engine) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-desk-models-'));
  try {
    const { reply } = engine === 'codex' ? await codexModels(cwd) : await claudeModels(cwd);
    if (!Array.isArray(reply)) throw new Error('Model catalog not returned');
    const models = [];
    const seen = new Set();
    for (const entry of reply) {
      const id = engine === 'codex' ? entry.model : entry.value;
      if (typeof id !== 'string' || id.length > 100 || !modelIdPattern.test(id) || seen.has(id)
        || engine === 'codex' && entry.hidden) continue;
      seen.add(id);
      models.push({
        id: engine === 'claude' && id === 'default' ? '' : id,
        label: typeof entry.displayName === 'string' ? entry.displayName.slice(0, 100) : id,
        recommended: engine === 'codex' ? Boolean(entry.isDefault) : id === 'default',
      });
    }
    return models;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function codexModels(cwd) {
  const list = [];
  let pages = 0;
  function request(cursor) {
    return { id: 2 + pages, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } };
  }
  return invoke('codex', ['app-server', '--stdio', ...codexLimits, '-c', 'model_provider="openai"', '-c', 'mcp_servers={}'], {
    cwd,
    protocol: {
      start: { id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_desk', version: '0.1.0' } } },
      receive(message, send) {
        if (message.id === 1) {
          if (!message.result) throw new Error('Codex model handshake failed');
          send({ method: 'initialized' });
          send(request(null));
        } else if (message.id === 2 + pages) {
          if (!Array.isArray(message.result?.data)) throw new Error('Codex did not return models');
          list.push(...message.result.data);
          if (!message.result.nextCursor || ++pages >= 4) return list;
          send(request(message.result.nextCursor));
        }
      },
    },
  });
}

function claudeModels(cwd) {
  return invoke('claude', [...claudeLimits, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
    cwd,
    protocol: {
      start: { type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } },
      receive(message) {
        if (message.type !== 'control_response' || message.response?.request_id !== 'models') return;
        const models = message.response.response?.models;
        if (!Array.isArray(models)) throw new Error('Claude did not return models');
        return models;
      },
    },
  });
}

export async function runEngine({ engine, model, prompt, signal }) {
  signal.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), 'agent-desk-run-'));
  try {
    const modelArgs = model ? ['--model', model] : [];
    const args = engine === 'codex' ? [
      '--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only',
      '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json',
      ...codexLimits, ...modelArgs, '-',
    ] : [
      ...claudeLimits, '--output-format', 'json', ...modelArgs,
    ];
    const { code, stdout } = await invoke(engine, args, { cwd, input: prompt, signal, timeout: 180_000 });
    const output = parseOutput(engine, stdout, code);
    if (!output) throw new Error('엔진이 응답을 반환하지 않았습니다. CLI 로그인, 모델 이름 또는 사용량을 확인하세요.');
    return output.slice(0, 24_000);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('엔진 CLI를 찾을 수 없습니다. 설치 상태를 확인하세요.');
    throw error;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function parseOutput(engine, stdout, code) {
  if (code !== 0) return '';
  if (engine === 'claude') {
    const result = JSON.parse(stdout);
    return !result.is_error && typeof result.result === 'string' ? result.result.trim() : '';
  }
  let output = '';
  let completed = false;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const event = JSON.parse(line);
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') output = event.item.text;
  }
  return completed ? String(output ?? '').trim() : '';
}
