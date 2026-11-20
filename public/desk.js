const nav = document.querySelector('#nav');
const content = document.querySelector('#content');
const locationLabel = document.querySelector('#location');
const connection = document.querySelector('#connection');
const dialog = document.querySelector('#dialog');
const form = document.querySelector('#dialog-form');
const formError = document.querySelector('#form-error');
const submit = document.querySelector('#dialog-submit');
const notice = document.querySelector('#notice');

const engineNames = { codex: 'Codex', claude: 'Claude Code' };
const engineStates = { ready: '로그인됨', missing: 'CLI 설치 필요', login_required: '로그인 필요', unavailable: '확인 실패' };
const statuses = {
  pending: '승인 대기', queued: '실행 대기', running: '실행 중', cancelling: '중단 중',
  succeeded: '완료', failed: '실패', cancelled: '취소됨', interrupted: '중단됨',
};
const eventNames = {
  pending: '업무 요청 등록', queued: '실행 승인', running: '엔진 실행 시작', cancelling: '중단 요청',
  succeeded: '결과 저장', failed: '실행 실패', cancelled: '취소 저장', interrupted: '서버 종료로 중단',
};
const sections = [
  ['work', '업무', '▤'], ['approvals', '승인함', '✓'], ['bots', '봇 팀', '◎'],
  ['notes', '메모리', '◇'], ['engines', '엔진 설정', '⌘'],
];
const date = new Intl.DateTimeFormat('ko', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => entities[char]);

let state;
let detail;
let channelFeed;
let engines = {};
let session;
let activeRefresh;
let refreshAgain = false;
let seenNav = '';
let seenContent = '';
let currentForm;
let botDialog;
let showDetail = false;
let jumpToLatest;
let toastTimeout;
const actions = new Set();
const retryIds = new Map();
const drafts = new Map();

function page() {
  const [section, first, second] = location.hash.slice(1).split('/');
  const active = sections.some(([key]) => key === section) ? section : 'work';
  const channelId = active === 'work' && state?.channels.some(({ id }) => id === first) ? first : 'general';
  return { active, channelId, taskId: active === 'work' ? second : active === 'approvals' ? first : undefined };
}

function taskLink(task) {
  return '#work/' + task.channelId + '/' + task.id;
}

function draftFor(channelId) {
  if (!drafts.has(channelId)) drafts.set(channelId, { prompt: '', botId: null, parentId: null });
  return drafts.get(channelId);
}

function defaultBotId() {
  return (state.bots.find(({ engine }) => engines[engine] === 'ready') ?? state.bots[0])?.id;
}

async function request(path, options = {}) {
  const { method = 'GET', body, retry = true } = options;
  let headers;
  if (method !== 'GET') {
    session ??= (await request('/session')).token;
    headers = { 'Content-Type': 'application/json', 'X-Desk-Token': session };
  }
  const response = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 403 && method !== 'GET' && retry) {
    session = undefined;
    return request(path, { ...options, retry: false });
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '요청을 처리하지 못했습니다.');
  return result;
}

function toast(message) {
  clearTimeout(toastTimeout);
  notice.textContent = message;
  notice.hidden = false;
  toastTimeout = setTimeout(() => { notice.hidden = true; }, 4800);
}

function setConnection(isOnline) {
  connection.classList.toggle('offline', !isOnline);
  connection.textContent = isOnline ? '로컬 서버 연결됨' : '서버 재연결 중';
  document.querySelector('.topbar button').disabled = !isOnline;
  const chat = document.querySelector('#chat-form button[type="submit"]');
  if (chat) chat.disabled = !isOnline || draftFor(page().channelId).sending === true;
}

function refresh() {
  refreshAgain = true;
  if (activeRefresh) return activeRefresh;
  activeRefresh = (async () => {
    while (refreshAgain) {
      refreshAgain = false;
      try {
        state = await request('/state');
        const view = page();
        const selectedId = view.taskId;
        const selected = state.tasks.find(({ id }) => id === selectedId);
        const previous = detail?.task;
        if (!selected) detail = undefined;
        else if (previous?.id !== selected.id || previous.updatedAt !== selected.updatedAt || previous.status !== selected.status) {
          detail = await request('/tasks/' + selected.id);
        }
        if (view.active === 'work') {
          const version = JSON.stringify(state.tasks.filter(({ channelId }) => channelId === view.channelId)
            .slice(0, 30).map(({ id, updatedAt, status }) => [id, updatedAt, status]));
          if (channelFeed?.id !== view.channelId || channelFeed.version !== version) {
            const { messages } = await request('/channels/' + view.channelId + '/feed');
            channelFeed = { id: view.channelId, version, messages };
          }
        }
        setConnection(true);
        render();
      } catch {
        setConnection(false);
        if (!state) content.innerHTML = '<p class="loading" role="status">서버에 연결할 수 없습니다. 연결을 다시 확인하는 중입니다.</p>';
      }
    }
  })().finally(() => { activeRefresh = undefined; });
  return activeRefresh;
}

function badge(status) {
  return '<span class="badge ' + escape(status) + '">' + escape(statuses[status]) + '</span>';
}

function engineState(engine) {
  const status = engines[engine];
  return '<span class="engine-state ' + (status === 'ready' ? 'ready' : '') + '">' +
    escape(engineStates[status] || '확인 중') + '</span>';
}

function avatar(bot) {
  return '<span class="avatar ' + escape(bot?.engine || '') + '" aria-hidden="true" data-glyph="' +
    escape(bot?.engine === 'claude' ? 'C' : '>_') + '"></span>';
}

function shortcut(action, label, extra = '', style = 'secondary') {
  return '<button class="button ' + style + '" type="button" data-action="' + action + '" ' + extra + '>' + label + '</button>';
}

function option(id, label, selected) {
  return '<option value="' + escape(id) + '"' + (selected ? ' selected' : '') + '>' + escape(label) + '</option>';
}

function renderNav(view) {
  const pending = state.tasks.filter(({ status }) => status === 'pending').length;
  const primary = sections.map(([key, label, glyph]) => {
    const count = key === 'approvals' && pending ? '<span class="nav-count">' + pending + '</span>' : '';
    return '<a href="#' + key + '" data-view="' + key + '" ' + (view.active === key ? 'aria-current="page"' : '') +
      '><span class="nav-icon" aria-hidden="true" data-glyph="' + glyph + '"></span>' + label + count + '</a>';
  }).join('');
  const channels = state.channels.map(({ id, name }) =>
    '<a class="channel-link" href="#work/' + id + '" ' + (view.active === 'work' && view.channelId === id ? 'aria-current="location"' : '') +
    '><span class="nav-icon" aria-hidden="true" data-glyph="#"></span><span>' + escape(name) + '</span></a>').join('');
  const html = '<div class="nav-primary">' + primary + '</div><div class="channel-menu">' +
    '<div class="nav-heading"><span>채널</span><button class="icon-button" type="button" data-action="new-channel" aria-label="채널 추가" data-glyph="+"></button></div>' +
    channels + '</div>';
  if (html !== seenNav) {
    seenNav = html;
    replacePreservingFocus(nav, html);
  }
}

function replacePreservingFocus(container, html) {
  const focused = document.activeElement;
  const inContainer = focused !== container && container.contains(focused);
  const identify = (node) => [node.tagName, node.getAttribute('href'), node.dataset.action, node.dataset.id,
    node.dataset.taskLink, node.getAttribute('aria-label'), node.id || node.getAttribute('name') || node.textContent].join('|');
  const key = inContainer ? identify(focused) : '';
  const selection = inContainer && focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : null;
  container.innerHTML = html;
  if (!key) return;
  const next = [...container.querySelectorAll('button, a, select, textarea, [tabindex="0"]')]
    .find((node) => identify(node) === key && !node.disabled);
  (next ?? container.querySelector('h1, h2, a'))?.focus({ preventScroll: true });
  if (selection && next instanceof HTMLTextAreaElement) next.setSelectionRange(...selection);
}

function heading(name, description, action = '') {
  const intro = description ? '<p class="intro">' + escape(description) + '</p>' : '';
  return '<div class="heading"><div><h1 tabindex="-1">' + escape(name) + '</h1>' + intro + '</div>' + action + '</div>';
}

function approvalList(tasks, view) {
  if (!tasks.length) {
    return '<div class="empty"><span class="empty-mark" aria-hidden="true" data-glyph="✓"></span>' +
      '<h3>승인할 업무가 없습니다</h3><p>검토를 요청한 업무가 여기에 표시됩니다.</p></div>';
  }
  return '<ul class="tasks">' + tasks.map((task) => {
    const channelName = state.channels.find(({ id }) => id === task.channelId)?.name;
    const label = (task.parentId ? '↳ ' : '') + task.prompt.replace(/\s+/g, ' ');
    const short = label.length > 100 ? label.slice(0, 100) + '…' : label;
    const active = view.taskId === task.id;
    const href = '#approvals/' + task.id;
    return '<li><a class="task-row' + (active ? ' selected' : '') + '" data-task-link="' + task.id + '" href="' + href + '" ' +
      (active ? 'aria-current="true"' : '') + '>' + avatar({ engine: task.botEngine }) + '<span class="task-label"><strong>' + escape(short) +
      '</strong><small>' + escape(task.botName) + ' · ' + escape(channelName) +
      '</small></span>' + badge(task.status) + '</a></li>';
  }).join('') + '</ul>';
}

function renderDetail(view, matches) {
  const task = detail?.task;
  if (!task || task.id !== view.taskId || (view.active === 'work' && view.channelId !== task.channelId)) {
    const active = matches.filter(({ status }) => ['queued', 'running', 'cancelling'].includes(status)).length;
    return '<aside class="inspector" aria-label="업무 현황"><div class="panel-head"><h2>업무 현황</h2></div>' +
      '<dl class="numbers"><div><dt>승인 대기</dt><dd>' + matches.filter(({ status }) => status === 'pending').length +
      '</dd></div><div><dt>진행 중</dt><dd>' + active + '</dd></div><div><dt>완료</dt><dd>' +
      matches.filter(({ status }) => status === 'succeeded').length + '</dd></div></dl>' +
      '<p class="panel-help">업무를 선택하면 요청, 실행 기록, 결과를 볼 수 있습니다.</p></aside>';
  }

  const { payload } = task;
  const dataId = 'data-id="' + task.id + '"';
  const noteSections = payload.notes.map(({ title, content: noteBody }) =>
    '<details><summary>메모리 · ' + escape(title) + '</summary><p class="text-block">' + escape(noteBody) + '</p></details>').join('');
  const attachment = payload.file ?
    '<details><summary>파일 · ' + escape(payload.file.name) + '</summary><p class="text-block">' + escape(payload.file.content) + '</p></details>' : '';
  const prior = payload.parent ? '<details><summary>이전 업무의 요청과 결과</summary><p class="text-block">' +
    escape(payload.parent.prompt) + '</p><p class="text-block">' + escape(payload.parent.output) + '</p></details>' : '';
  const upstream = state.tasks.find(({ id }) => id === (task.parentId || task.retryOf));
  const next = state.tasks.filter(({ parentId }) => parentId === task.id).toReversed();
  const related = (upstream || next.length) ? '<div class="related">' +
    (upstream ? '<a data-task-link="' + upstream.id + '" href="' + taskLink(upstream) + '">' +
      (task.parentId ? '← 이전 업무' : '← 원래 요청') + '</a>' : '') + next.map((child) =>
      '<a data-task-link="' + child.id + '" href="' + taskLink(child) + '">↳ ' + escape(child.prompt.slice(0, 70)) + '</a>').join('') + '</div>' : '';
  const model = payload.bot.model ? ' · ' + escape(payload.bot.model) : '';
  const recipient = '<div class="recipient">' + avatar(payload.bot) + '<div><strong>' + escape(payload.bot.name) + '</strong><small>' +
    escape(engineNames[payload.bot.engine]) + model + '</small></div></div>';
  let action = '';
  if (task.status === 'pending') {
    action = '<p class="panel-help">승인하면 요청과 선택한 자료가 ' + escape(engineNames[payload.bot.engine]) +
      '에 전달됩니다.</p><div class="button-row">' + shortcut('cancel', '요청 취소', dataId) +
      shortcut('approve', '승인하고 실행', dataId, 'primary') + '</div>';
  } else if (['queued', 'running'].includes(task.status)) {
    action = '<div class="button-row">' + shortcut('cancel', '실행 중단', dataId) + '</div>';
  } else if (['failed', 'cancelled', 'interrupted'].includes(task.status)) {
    action = '<div class="button-row">' + shortcut('retry', '다시 요청', dataId, 'primary') + '</div>';
  } else if (task.status === 'succeeded') {
    action = '<div class="button-row">' + shortcut('copy', '결과 복사', dataId) +
      shortcut('followup', '후속 업무', dataId, 'primary') + '</div>';
  }

  const close = view.active === 'work' ? '<a class="detail-close" href="#work/' + task.channelId + '" aria-label="업무 상세 닫기">×</a>' : '';
  return '<aside class="inspector detail" id="task-detail" aria-labelledby="detail-heading"><div class="panel-head">' +
    '<h2 id="detail-heading" tabindex="-1">업무 상세</h2><span class="detail-meta">' + badge(task.status) + close + '</span></div><div class="detail-body">' +
    recipient + '<h3>요청 내용</h3><p class="text-block">' + escape(payload.prompt) + '</p>' +
    (prior || noteSections || attachment ? '<h3>함께 보내는 자료</h3>' + prior + noteSections + attachment : '') +
    (task.output ? '<h3>결과</h3><p class="text-block result">' + escape(task.output) + '</p>' : '') +
    (task.error ? '<p class="feedback">' + escape(task.error) + '</p>' : '') + related +
    '<h3>실행 기록</h3><ol class="timeline">' + task.events.map(({ kind, at }) =>
      '<li><span>' + escape(eventNames[kind]) + '</span><time datetime="' + new Date(at).toISOString() + '">' +
      escape(date.format(at)) + '</time></li>').join('') + '</ol></div><div class="detail-actions">' + action + '</div></aside>';
}

function renderApprovals(view) {
  const matches = state.tasks.filter(({ id, status }) => status === 'pending' || id === view.taskId);
  return heading('승인함', '업무를 승인하기 전에 요청 내용과 전달할 자료를 확인하세요.') +
    '<div class="split"><section class="panel" aria-labelledby="task-list-heading"><div class="panel-head">' +
    '<h2 id="task-list-heading">검토할 요청</h2><span class="total">' + matches.filter(({ status }) => status === 'pending').length +
    '건</span></div>' + approvalList(matches, view) + '</section>' + renderDetail(view, matches) + '</div>';
}

function chatMessage(task, message) {
  const dataId = 'data-id="' + task.id + '"';
  const link = '<a data-task-link="' + task.id + '" href="' + taskLink(task) + '">실행 기록</a>';
  let output = '';
  if (message?.output) {
    output = '<p class="text-block">' + escape(message.output) + '</p><div class="chat-tools">' +
      shortcut('copy', '복사', dataId) + shortcut('chat-reply', '이어서 요청', dataId) + '</div>';
  } else if (message?.error) output = '<p class="feedback">' + escape(message.error) + '</p>';
  const context = task.parentId ? '<span class="chat-context">이전 업무에 이어서</span>' : '';
  const approval = task.status === 'pending' ? '<a href="#approvals/' + task.id + '" data-task-link="' + task.id + '">승인함에서 열기</a>' : '';
  return '<article class="chat-message"><div class="chat-prompt"><div class="chat-label"><strong>나</strong><time datetime="' +
    new Date(task.createdAt).toISOString() + '">' + escape(date.format(task.createdAt)) + '</time>' + context +
    '</div><p class="text-block">' + escape(message?.prompt || task.prompt) + '</p></div>' +
    '<div class="chat-answer">' + avatar({ engine: task.botEngine }) + '<div class="answer-body"><div class="chat-label"><strong>' +
    escape(task.botName) + '</strong>' + badge(task.status) + '</div>' + output +
    '<div class="chat-links">' + approval + link + '</div></div></div></article>';
}

function chatComposer(channelId) {
  const draft = draftFor(channelId);
  const context = draft.parentId ? '<div class="reply-context"><span>이전 업무의 요청과 결과를 함께 보냅니다.</span>' +
    shortcut('chat-clear-reply', '해제') + '</div>' : '';
  const bots = state.bots.map((bot) => option(bot.id, bot.name, bot.id === (draft.botId || defaultBotId()))).join('');
  return '<form id="chat-form" data-channel="' + channelId + '"><label class="sr-only" for="chat-prompt">메시지</label>' + context +
    '<textarea id="chat-prompt" name="prompt" rows="2" maxlength="6000" required placeholder="봇에게 맡길 일을 입력하세요">' +
    escape(draft.prompt) + '</textarea><div class="composer-actions"><label class="chat-target"><span>받는 봇</span>' +
    '<select name="botId">' + bots + '</select></label><div class="chat-controls">' + shortcut('chat-attach', '자료 첨부') +
    '<button class="button primary" type="submit"' + (draft.sending ? ' disabled' : '') + '>보내기</button></div></div>' +
    '<p class="composer-hint">메시지는 선택한 엔진으로 전송됩니다.</p></form>';
}

function renderWork(view) {
  const channel = state.channels.find(({ id }) => id === view.channelId);
  const tasks = state.tasks.filter(({ channelId }) => channelId === channel.id);
  const messages = new Map((channelFeed?.id === channel.id ? channelFeed.messages : []).map((message) => [message.id, message]));
  const older = tasks.slice(30);
  const archive = older.length ? '<details class="chat-archive"><summary>이전 업무 ' + older.length + '개</summary><ul>' +
    older.map((task) => '<li><a data-task-link="' + task.id + '" href="' + taskLink(task) + '">' +
      escape(task.prompt.slice(0, 100)) + '</a></li>').join('') + '</ul></details>' : '';
  const latest = tasks.length ? tasks.slice(0, 30).toReversed().map((task) => chatMessage(task, messages.get(task.id))).join('') :
    '<div class="empty"><span class="empty-mark" aria-hidden="true" data-glyph="▤"></span><h2>봇에게 첫 메시지를 보내세요</h2></div>';
  const inspector = detail?.task.id === view.taskId && detail?.task.channelId === channel.id;
  return '<div class="chat-title">' + heading(channel.name, channel.description) + '</div><div class="' + (inspector ? 'split' : 'chat-single') +
    '"><section class="panel conversation" aria-label="채널 대화"><div class="chat-feed" id="chat-feed" data-channel="' + channel.id +
    '" role="region" aria-label="업무 메시지" tabindex="0">' + archive + latest + '</div>' + chatComposer(channel.id) + '</section>' +
    (inspector ? renderDetail(view, tasks) : '') + '</div>';
}

function renderBots() {
  return heading('봇 팀', '엔진과 담당 역할을 정해 업무를 나눕니다.', shortcut('new-bot', '＋ 봇 추가', '', 'primary')) +
    '<div class="card-grid">' + state.bots.map((bot) => '<article class="card"><div class="card-top">' +
      avatar(bot) + engineState(bot.engine) + '</div><h2>' + escape(bot.name) + '</h2><p>' + escape(bot.role || '지정된 역할 없음') +
      '</p><div class="card-foot"><span>' + escape(engineNames[bot.engine]) + '</span><span>' +
      escape(bot.model || '기본 모델') + '</span></div>' +
      (bot.folder ? '<p class="folder">작업 폴더 · <code>' + escape(bot.folder) + '</code></p>' : '') +
      '<div class="bot-actions">' + shortcut('edit-bot', '수정', 'data-id="' + bot.id + '" aria-label="' + escape(bot.name) + ' 설정 수정"') +
      '</div></article>').join('') + '</div>';
}

function renderNotes() {
  return heading('메모리', '반복해서 쓰는 업무 기준을 보관하고 필요한 요청에 선택해 전달합니다.',
    shortcut('new-note', '＋ 메모리 추가', '', 'primary')) +
    (state.notes.length ? '<div class="card-grid">' + state.notes.map((note) =>
      '<article class="card"><h2>' + escape(note.title) + '</h2><p class="text-block">' + escape(note.content) +
      '</p><div class="card-foot">' + shortcut('edit-note', '편집', 'data-id="' + note.id + '"') +
      shortcut('delete-note', '삭제', 'data-id="' + note.id + '"') + '</div></article>').join('') + '</div>'
      : '<section class="panel empty"><span class="empty-mark" aria-hidden="true" data-glyph="◇"></span><h2>저장된 메모리가 없습니다</h2>' +
      '<p>작성 기준이나 제품 정보를 등록해 다음 업무에서 재사용할 수 있습니다.</p></section>');
}

function renderEngines() {
  const commands = { codex: 'codex login', claude: 'claude auth login' };
  return heading('엔진 설정', '이 Mac에서 CLI에 로그인한 계정을 사용합니다.',
    shortcut('refresh-engines', '연결 다시 확인', '', 'primary')) +
    '<div class="card-grid">' + Object.entries(engineNames).map(([key, name]) =>
      '<article class="card"><div class="card-top">' + avatar({ engine: key }) + engineState(key) +
      '</div><h2>' + name + '</h2><p>계정을 연결하거나 바꿀 때 해당 CLI에서 로그인하세요.</p><code class="command">' +
      commands[key] + '</code></article>').join('') + '</div><p class="footnote">모델 호출은 연결한 계정의 이용 한도에 적용됩니다.</p>';
}

function render() {
  const view = page();
  renderNav(view);
  const channel = state.channels.find(({ id }) => id === view.channelId);
  locationLabel.textContent = view.active === 'work' ? '채널 / ' + channel.name :
    sections.find(([key]) => key === view.active)[1];
  document.querySelector('.topbar').hidden = view.active === 'work';
  const sectionsByView = { work: renderWork, approvals: renderApprovals, bots: renderBots, notes: renderNotes, engines: renderEngines };
  const html = sectionsByView[view.active](view);
  if (html !== seenContent) {
    const previous = document.querySelector('#chat-feed');
    const sameChannel = previous?.dataset.channel === view.channelId;
    const oldTop = previous?.scrollTop ?? 0;
    const nearEnd = sameChannel && previous.scrollHeight - previous.clientHeight - oldTop < 56;
    seenContent = html;
    replacePreservingFocus(content, html);
    const next = document.querySelector('#chat-feed');
    if (next) {
      const latest = !sameChannel || nearEnd || jumpToLatest === view.channelId;
      next.scrollTop = latest ? next.scrollHeight : oldTop;
      if (jumpToLatest === view.channelId) jumpToLatest = undefined;
    }
  }
  if (showDetail && detail?.task.id === view.taskId) {
    showDetail = false;
    document.querySelector('#detail-heading')?.focus();
  }
}

function openForm(title, label, fields, perform) {
  botDialog = undefined;
  document.querySelector('#dialog-title').textContent = title;
  document.querySelector('#dialog-fields').innerHTML = fields;
  formError.hidden = true;
  submit.textContent = label;
  currentForm = perform;
  dialog.showModal();
  form.querySelector('input:not([type="checkbox"]), select, textarea')?.focus();
}

function textField(name, label, max, { value = '', hint = '', required = false, multiline = false } = {}) {
  const id = 'dialog-' + name;
  const attrs = 'id="' + id + '" name="' + name + '" maxlength="' + max + '"' + (required ? ' required' : '') +
    (hint ? ' aria-describedby="' + id + '-hint"' : '');
  const control = multiline ? '<textarea ' + attrs + ' rows="4">' + escape(value) + '</textarea>' :
    '<input type="text" ' + attrs + ' value="' + escape(value) + '">';
  return '<div class="field"><label for="' + id + '">' + label + '</label>' + control +
    (hint ? '<small id="' + id + '-hint">' + hint + '</small>' : '') + '</div>';
}

function selectField(name, label, options) {
  return '<label class="field"><span>' + label + '</span><select name="' + name + '">' + options + '</select></label>';
}

function openTask(parent = null, draft = null) {
  const view = page();
  const requestId = crypto.randomUUID();
  const chosenBot = draft ? draft.botId || defaultBotId() :
    parent ? state.bots.find(({ id }) => id !== parent.botId)?.id : defaultBotId();
  const botOptions = state.bots.map((bot) =>
    option(bot.id, bot.name + ' · ' + (engineStates[engines[bot.engine]] || engineNames[bot.engine]), bot.id === chosenBot)).join('');
  const channelOptions = state.channels.map(({ id, name }) => option(id, name, id === view.channelId)).join('');
  const noteOptions = state.notes.map(({ title, id }) => '<label class="check"><input name="note" type="checkbox" value="' + id + '">' +
    '<span>' + escape(title) + '</span></label>').join('');
  const extra = noteOptions ? '<fieldset><legend>함께 보낼 메모리 (최대 5개)</legend><div class="checks">' + noteOptions + '</div></fieldset>' : '';
  openForm(parent ? '후속 업무 요청' : '새 업무 요청', '승인함에 등록', (parent ?
    '<p class="form-note">이전 업무의 요청과 결과를 함께 전달합니다.</p>' : selectField('channelId', '채널', channelOptions)) +
    selectField('botId', '담당 봇', botOptions) +
    textField('prompt', '업무 요청', 6000, { value: draft?.prompt, required: true, multiline: true }) +
    '<div id="attachment-field">' + textField('file', '첨부할 텍스트 파일 (선택)', 320, { hint: '봇 작업 폴더 기준 상대 경로 · 최대 32KB' }) +
    '</div>' + extra, async (data) => {
      const { task } = await request('/tasks', { method: 'POST', body: {
        requestId, channelId: parent?.channelId ?? data.get('channelId'), botId: data.get('botId'),
        parentId: parent?.id, prompt: data.get('prompt'), file: data.get('file') || '', noteIds: data.getAll('note'),
      } });
      if (draft) {
        draft.prompt = '';
        draft.parentId = null;
      }
      location.hash = '#approvals/' + task.id;
      showDetail = true;
      toast('승인함에 업무를 등록했습니다.');
    });
  updateAttachment();
}

function updateAttachment() {
  const field = document.querySelector('#attachment-field');
  if (!field) return;
  const bot = state.bots.find(({ id }) => id === form.elements.namedItem('botId').value);
  const input = field.querySelector('input');
  input.disabled = !bot?.folder;
  field.hidden = input.disabled;
  if (input.disabled) input.value = '';
}

function openChannel() {
  openForm('채널 추가', '채널 만들기', textField('name', '채널 이름', 32, { required: true }) +
    textField('description', '설명 (선택)', 160), async (data) => {
    const { channel } = await request('/channels', { method: 'POST', body: Object.fromEntries(data) });
    location.hash = '#work/' + channel.id;
  });
}

function openBot(bot = null) {
  openForm(bot ? '봇 설정 수정' : '봇 추가', bot ? '저장' : '봇 만들기',
    textField('name', '봇 이름', 32, { value: bot?.name, required: true }) +
    selectField('engine', '엔진', Object.entries(engineNames).map(([key, label]) => option(key, label, key === bot?.engine)).join('')) +
    textField('role', '맡길 역할 (선택)', 600, { value: bot?.role, multiline: true }) +
    '<label class="field"><span>모델</span><select name="model" aria-describedby="model-status"></select></label>' +
    '<p class="model-status" id="model-status" aria-live="polite"></p>' +
    textField('folder', '작업 폴더 (선택)', 800, { value: bot?.folder, hint: '절대 경로 입력 · 요청에 선택한 텍스트 파일만 읽습니다.' }),
  async (data) => {
    await request(bot ? '/bots/' + bot.id : '/bots', { method: bot ? 'PATCH' : 'POST', body: Object.fromEntries(data) });
    toast(bot ? '봇 설정을 저장했습니다.' : '봇을 추가했습니다.');
  });
  botDialog = { values: new Map(bot ? [[bot.engine, bot.model]] : []), sequence: 0 };
  void updateModels();
}

async function updateModels() {
  const context = botDialog;
  if (!context) return;
  const sequence = ++context.sequence;
  const engine = form.elements.namedItem('engine').value;
  const model = form.elements.namedItem('model');
  const help = document.querySelector('#model-status');
  const selected = context.values.get(engine) || '';
  function show(models) {
    const suggested = models.find(({ id, recommended }) => id && recommended);
    const prior = selected && !models.some(({ id }) => id === selected) ? option(selected, '저장된 모델 · ' + selected, true) : '';
    model.innerHTML = option('', 'CLI 기본 모델' + (suggested ? ' · ' + suggested.label : ''), !selected) + prior +
      models.filter(({ id }) => id).map(({ id, label }) => option(id, label, id === selected)).join('');
  }
  show([]);
  help.textContent = '이 엔진에서 사용 가능한 모델을 확인 중입니다.';
  try {
    const { availability, models } = await request('/models/' + engine);
    if (botDialog !== context || sequence !== context.sequence || !dialog.open) return;
    show(models);
    help.textContent = availability === 'ready' && models.length ? '' : availability === 'login_required' || availability === 'missing' ?
      (engineStates[availability] + ' · 엔진 설정에서 연결을 확인하세요.') : '모델 목록을 가져오지 못했습니다. CLI 기본 모델이나 저장된 모델을 사용할 수 있습니다.';
  } catch {
    if (botDialog === context && sequence === context.sequence && dialog.open) help.textContent = '모델 목록을 가져오지 못했습니다.';
  }
}

function openNote(note) {
  openForm(note ? '메모리 편집' : '메모리 추가', '저장', textField('title', '제목', 60, { value: note?.title, required: true }) +
    textField('content', '메모리 내용', 2500, { value: note?.content, required: true, multiline: true }), async (data) => {
    await request(note ? '/notes/' + note.id : '/notes', { method: note ? 'PATCH' : 'POST', body: Object.fromEntries(data) });
    toast('메모리를 저장했습니다.');
  });
}

function deleteNote(note) {
  openForm('메모리 삭제', '삭제', '<p class="form-note">‘' + escape(note.title) +
    '’을 메모리에서 삭제합니다. 이전 업무에 첨부된 사본은 실행 기록에 남습니다.</p>', async () => {
    await request('/notes/' + note.id, { method: 'DELETE', body: {} });
    toast('메모리를 삭제했습니다.');
  });
}

async function runAction(action, id, button) {
  const key = action + ':' + (id ?? '');
  if (actions.has(key)) return;
  actions.add(key);
  button.disabled = true;
  try {
    if (action === 'refresh-engines') {
      engines = (await request('/engines', { method: 'POST', body: {} })).engines;
      render();
      toast('CLI 로그인 상태를 확인했습니다.');
    } else if (action === 'copy') {
      const output = channelFeed?.messages.find((message) => message.id === id)?.output ??
        (detail?.task.id === id ? detail.task.output : (await request('/tasks/' + id)).task.output);
      await navigator.clipboard.writeText(output);
      toast('결과를 복사했습니다.');
    } else {
      const body = {};
      if (action === 'retry') {
        if (!retryIds.has(id)) retryIds.set(id, crypto.randomUUID());
        body.requestId = retryIds.get(id);
      }
      const { task } = await request('/tasks/' + id + '/' + action, { method: 'POST', body });
      if (action === 'retry') {
        retryIds.delete(id);
        location.hash = '#approvals/' + task.id;
        showDetail = true;
        toast('다시 실행할 요청을 승인함에 등록했습니다.');
      }
      if (action === 'approve') toast('실행을 승인했습니다.');
      if (action === 'cancel') toast('취소 또는 중단을 요청했습니다.');
      await refresh();
      const next = document.querySelector('#detail-heading');
      if (next && next.offsetParent && document.activeElement === document.body) next.focus({ preventScroll: true });
    }
  } catch (error) {
    toast(error.message);
  } finally {
    actions.delete(key);
    button.disabled = false;
  }
}

form.addEventListener('change', (event) => {
  if (event.target.name === 'botId') updateAttachment();
  if (event.target.name === 'engine') void updateModels();
  if (event.target.name === 'model' && botDialog) botDialog.values.set(form.elements.namedItem('engine').value, event.target.value);
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true;
  formError.hidden = true;
  try {
    await currentForm(new FormData(form));
    dialog.close();
    await refresh();
  } catch (error) {
    formError.textContent = error.message;
    formError.hidden = false;
  } finally {
    submit.disabled = false;
  }
});
dialog.addEventListener('cancel', (event) => {
  if (submit.disabled) event.preventDefault();
});

content.addEventListener('input', (event) => {
  const chat = event.target.closest('#chat-form');
  if (!chat || !['prompt', 'botId'].includes(event.target.name)) return;
  draftFor(chat.dataset.channel)[event.target.name] = event.target.value;
});
content.addEventListener('keydown', (event) => {
  if (event.target.id === 'chat-prompt' && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});
content.addEventListener('submit', async (event) => {
  const chat = event.target.closest('#chat-form');
  if (!chat) return;
  event.preventDefault();
  const channelId = chat.dataset.channel;
  const draft = draftFor(channelId);
  const data = new FormData(chat);
  const prompt = String(data.get('prompt')).trim();
  const botId = data.get('botId');
  if (!prompt || !botId || draft.sending) return;
  const parentId = draft.parentId;
  const signature = JSON.stringify({ prompt, botId, parentId });
  if (draft.last?.signature !== signature) draft.last = { signature, requestId: crypto.randomUUID() };
  draft.sending = true;
  const button = chat.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await request('/tasks', { method: 'POST', body: {
      channelId, botId, parentId, prompt, direct: true, requestId: draft.last.requestId,
    } });
    if (draft.prompt.trim() === prompt) draft.prompt = '';
    if (draft.parentId === parentId) draft.parentId = null;
    draft.last = undefined;
    jumpToLatest = channelId;
  } catch (error) {
    toast(error.message);
  } finally {
    draft.sending = false;
    await refresh();
    if (button.isConnected) button.disabled = connection.classList.contains('offline');
  }
});

document.addEventListener('click', (event) => {
  if (event.target.closest('.skip')) {
    event.preventDefault();
    document.querySelector('#main').focus();
    return;
  }
  const link = event.target.closest('[data-task-link]');
  if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    if (link.hash === location.hash) document.querySelector('#detail-heading')?.focus();
    else showDetail = true;
  }
  const button = event.target.closest('button[data-action]');
  if (!button || !state) return;
  const { action, id } = button.dataset;
  if (action === 'dialog-close') {
    if (!submit.disabled) dialog.close();
  } else if (action === 'new-task') openTask();
  else if (action === 'followup') openTask(detail.task);
  else if (action === 'chat-attach') {
    const draft = draftFor(page().channelId);
    openTask(state.tasks.find(({ id }) => id === draft.parentId), draft);
  } else if (action === 'chat-reply' || action === 'chat-clear-reply') {
    const draft = draftFor(page().channelId);
    draft.parentId = id || null;
    render();
    document.querySelector('#chat-prompt')?.focus();
  } else if (action === 'new-channel') openChannel();
  else if (action === 'new-bot') openBot();
  else if (action === 'edit-bot') openBot(state.bots.find((bot) => bot.id === id));
  else if (action === 'new-note') openNote();
  else if (action === 'edit-note') openNote(state.notes.find((note) => note.id === id));
  else if (action === 'delete-note') deleteNote(state.notes.find((note) => note.id === id));
  else void runAction(action, id, button);
});

async function loadEngines() {
  try {
    engines = (await request('/engines')).engines;
    if (state) render();
  } catch {
    engines = {};
  }
}

addEventListener('hashchange', () => {
  void refresh();
  if (page().active === 'engines') void loadEngines();
});
const events = new EventSource('/api/events');
events.addEventListener('change', () => { void refresh(); });
events.addEventListener('open', () => { void refresh(); });
events.addEventListener('error', () => { setConnection(false); });
setInterval(() => { void refresh(); }, 15_000);
void refresh();
void loadEngines();
