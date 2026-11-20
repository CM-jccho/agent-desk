import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDesk } from '../service.mjs';
import { openStore } from '../store.mjs';

async function fixture(t, run = async () => '완료', models) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-desk-test-'));
  const desks = [];
  t.after(async () => {
    await Promise.all(desks.map((desk) => desk.close()));
    await rm(directory, { recursive: true, force: true });
  });
  async function open() {
    const desk = await createDesk({ directory, port: 0, run, models, probe: async () => 'ready' });
    desks.push(desk);
    return desk;
  }
  const desk = await open();
  return { desk, open, directory, client: await connect(desk) };
}

async function connect(desk) {
  const { token } = await (await fetch(desk.url + '/api/session')).json();
  return async function request(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(desk.url + '/api/' + path, {
      method,
      headers: body ? { origin: desk.url, 'content-type': 'application/json', 'x-desk-token': token } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    return { status: response.status, ...data };
  };
}

const brief = { channelId: 'general', botId: 'codex', prompt: '주간 회의 안건을 정리해 주세요.' };

async function waitFor(client, id, status) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { task } = await client('tasks/' + id);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Task did not reach ${status}`);
}

test('an approval runs exactly once, preserves the thread, and survives a restart', async (t) => {
  const inputs = [];
  const { client, desk, open } = await fixture(t, async (input) => {
    inputs.push(input.prompt);
    return '검토 결과';
  });
  const created = await client('tasks', { ...brief, requestId: 'first-request' });
  assert.equal(created.status, 201);
  const duplicate = await client('tasks', { ...brief, requestId: 'first-request' });
  assert.equal(duplicate.task.id, created.task.id);
  assert.equal((await client('tasks', { ...brief, prompt: '다른 내용', requestId: 'first-request' })).status, 409);
  assert.equal(created.task.status, 'pending');
  assert.deepEqual(inputs, []);

  const approvals = await Promise.all([
    client(`tasks/${created.task.id}/approve`, {}),
    client(`tasks/${created.task.id}/approve`, {}),
  ]);
  assert.deepEqual(approvals.map((result) => result.status).sort(), [200, 409]);
  const completed = await waitFor(client, created.task.id, 'succeeded');
  assert.equal(completed.output, '검토 결과');
  assert.equal(inputs.length, 1);

  const followup = await client('tasks', { ...brief, requestId: 'follow-up', parentId: completed.id, botId: 'claude' });
  await client(`tasks/${followup.task.id}/approve`, {});
  await waitFor(client, followup.task.id, 'succeeded');
  assert.match(inputs[1], /검토 결과/);
  await desk.close();
  const restarted = await connect(await open());
  const state = await restarted('state');
  assert.equal(state.tasks.length, 2);
  const saved = await restarted('tasks/' + completed.id);
  assert.deepEqual(saved.task.events.map((event) => event.kind),
    ['pending', 'queued', 'running', 'succeeded']);
  assert.equal(inputs.length, 2);
});

test('memory is optional and approved context is frozen, with folder escapes denied', async (t) => {
  let input;
  const { client, directory } = await fixture(t, async (run) => {
    input = run.prompt;
    return '완료';
  });
  const project = await mkdtemp(join(directory, 'project-'));
  await writeFile(join(project, 'agenda.md'), '승인에 포함될 원본');
  await writeFile(join(directory, 'private.md'), '보호 문서');
  await symlink(join(directory, 'private.md'), join(project, 'shortcut.md'));
  const { bot } = await client('bots', { name: '기획 담당', engine: 'codex', folder: project, role: '기획' });
  const { note } = await client('notes', { title: '기억', content: '검증된 내부 기준' });
  assert.equal((await client('tasks', { ...brief, botId: bot.id, requestId: 'unsafe-file', file: 'shortcut.md' })).status, 400);
  const draft = await client('tasks', { ...brief, botId: bot.id, requestId: 'snapshot', file: 'agenda.md', noteIds: [note.id] });
  assert.equal(draft.status, 201);
  await writeFile(join(project, 'agenda.md'), '수정된 문서');
  await client(`notes/${note.id}`, { title: '기억', content: '바뀐 기준' }, 'PATCH');
  await client(`tasks/${draft.task.id}/approve`, {});
  await waitFor(client, draft.task.id, 'succeeded');
  assert.match(input, /승인에 포함될 원본/);
  assert.match(input, /검증된 내부 기준/);
  assert.doesNotMatch(input, /수정된 문서|바뀐 기준|보호 문서/);
});

test('cancel releases the bot lane and an explicit retry is a fresh approval', async (t) => {
  let calls = 0;
  const { client } = await fixture(t, ({ signal }) => {
    if (++calls > 1) return Promise.resolve('완료');
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const first = (await client('tasks', { ...brief, requestId: 'cancel-first' })).task;
  const next = (await client('tasks', { ...brief, requestId: 'cancel-next' })).task;
  await client(`tasks/${first.id}/approve`, {});
  await waitFor(client, first.id, 'running');
  await client(`tasks/${next.id}/approve`, {});
  await waitFor(client, next.id, 'queued');
  assert.equal(calls, 1);
  await client(`tasks/${first.id}/cancel`, {});
  await waitFor(client, first.id, 'cancelled');
  await waitFor(client, next.id, 'succeeded');
  const retry = await client(`tasks/${first.id}/retry`, { requestId: 'retry-first' });
  assert.equal(retry.task.status, 'pending');
  assert.equal(retry.task.retryOf, first.id);
  assert.equal(calls, 2);
});

test('blocks foreign origins, unprotected writes, and concurrent access to the data directory', async (t) => {
  const { desk, open } = await fixture(t);
  assert.equal((await fetch(desk.url + '/api/state', { headers: { origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(desk.url + '/api/tasks', {
    method: 'POST',
    headers: { origin: desk.url, 'content-type': 'application/json' },
    body: '{}',
  })).status, 403);
  await assert.rejects(open(), /이미 사용 중/);
});

test('restart resumes a queued task and preserves an interrupted task for explicit review', async (t) => {
  const completed = [];
  const { client, desk, directory, open } = await fixture(t, async ({ prompt }) => {
    completed.push(prompt);
    return '완료';
  });
  const first = (await client('tasks', { ...brief, prompt: '이전 실행', requestId: 'prior' })).task;
  const second = (await client('tasks', { ...brief, prompt: '대기한 실행', requestId: 'waiting' })).task;
  await desk.close();
  const persisted = openStore(directory);
  persisted.change(first.id, 'pending', 'queued');
  persisted.change(first.id, 'queued', 'running');
  persisted.change(second.id, 'pending', 'queued');
  persisted.close();

  const afterRestart = await connect(await open());
  const resumed = await waitFor(afterRestart, second.id, 'succeeded');
  const interrupted = await waitFor(afterRestart, first.id, 'interrupted');
  assert.equal(resumed.output, '완료');
  assert.equal(interrupted.events.at(-1).kind, 'interrupted');
  assert.equal(completed.length, 1);
  assert.match(completed[0], /대기한 실행/);
});

test('two different bots run together while additional work waits for a lane', async (t) => {
  const inFlight = new Map();
  const { client } = await fixture(t, ({ prompt, signal }) => new Promise((resolve, reject) => {
    const key = prompt.split('\n').at(-1);
    inFlight.set(key, resolve);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const { bot } = await client('bots', { name: '보조 봇', engine: 'codex' });
  const tasks = [];
  for (const [index, botId] of ['codex', 'claude', bot.id].entries()) {
    const key = '업무 ' + index;
    const { task } = await client('tasks', { ...brief, botId, prompt: key, requestId: 'lane-' + index });
    tasks.push(task.id);
    await client('tasks/' + task.id + '/approve', {});
  }
  await waitFor(client, tasks[0], 'running');
  await waitFor(client, tasks[1], 'running');
  await waitFor(client, tasks[2], 'queued');
  assert.deepEqual([...inFlight.keys()], ['업무 0', '업무 1']);
  inFlight.get('업무 0')('완료');
  await waitFor(client, tasks[2], 'running');
  inFlight.get('업무 2')('완료');
  inFlight.get('업무 1')('완료');
  await waitFor(client, tasks[2], 'succeeded');
});

test('bot settings are editable and earlier approval payloads keep their original engine and model', async (t) => {
  const { client, desk, open } = await fixture(t);
  const { bot } = await client('bots', { name: '빌더', engine: 'codex', model: 'example-codex' });
  const old = (await client('tasks', { ...brief, botId: bot.id, requestId: 'before-edit' })).task;
  const update = await client('bots/' + bot.id, { name: '초안 봇', engine: 'claude', role: '문서 초안', model: 'example-claude' }, 'PATCH');
  assert.equal(update.status, 200);
  assert.equal(update.bot.id, bot.id);
  assert.equal((await client('tasks/' + old.id)).task.payload.bot.engine, 'codex');
  assert.equal((await client('tasks/' + old.id)).task.payload.bot.model, 'example-codex');
  const next = (await client('tasks', { ...brief, botId: bot.id, requestId: 'after-edit' })).task;
  assert.equal(next.payload.bot.name, '초안 봇');
  assert.equal(next.payload.bot.engine, 'claude');
  assert.equal(next.payload.bot.model, 'example-claude');
  assert.equal((await client('bots/' + bot.id, { name: 'Codex', engine: 'claude' }, 'PATCH')).status, 409);
  await desk.close();
  const restarted = await connect(await open());
  assert.equal((await restarted('state')).bots.find(({ id }) => id === bot.id).name, '초안 봇');
});

test('model discovery returns the selected engine catalog and recovers a failed lookup after refresh', async (t) => {
  const calls = [];
  let fail = true;
  const { client } = await fixture(t, undefined, async (engine) => {
    calls.push(engine);
    if (engine === 'claude' && fail) throw new Error('catalog unavailable');
    return [{ id: engine + '-test', label: engine, recommended: true }];
  });
  assert.deepEqual((await client('models/codex')).models, [{ id: 'codex-test', label: 'codex', recommended: true }]);
  assert.deepEqual((await client('models/codex')).models, [{ id: 'codex-test', label: 'codex', recommended: true }]);
  assert.equal((await client('models/claude')).status, 200);
  assert.equal((await client('models/claude')).availability, 'unavailable');
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.equal((await client('models/other')).status, 404);
  fail = false;
  await client('engines', {});
  const available = await client('models/claude');
  assert.equal(available.availability, 'ready');
  assert.equal(available.models[0].id, 'claude-test');
});

test('plain channel messages run from an explicit send and structured requests still wait for approval', async (t) => {
  const { client } = await fixture(t);
  const input = { ...brief, requestId: 'chat-execution', direct: true };
  const first = await client('tasks', input);
  assert.equal(first.status, 201);
  assert.equal((await client('tasks', input)).task.id, first.task.id);
  const complete = await waitFor(client, first.task.id, 'succeeded');
  assert.deepEqual(complete.events.map(({ kind }) => kind), ['pending', 'queued', 'running', 'succeeded']);
  const { notes } = await client('state');
  assert.equal(notes.length, 0);
  assert.equal((await client('tasks', { ...brief, requestId: 'chat-with-file', direct: true, file: 'notes.md' })).status, 400);
  const feed = await client('channels/general/feed');
  assert.deepEqual(feed.messages, [{ id: first.task.id, prompt: brief.prompt, output: '완료', error: '' }]);
  assert.deepEqual((await client('channels/review/feed')).messages, []);
});
