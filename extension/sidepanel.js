// 사이드패널: 큐 편집과 상태 표시. 실제 실행은 Flow 페이지의 content.js가 한다.
const $ = (id) => document.getElementById(id);
const STATUS_TEXT = { pending: '대기', running: '진행 중', done: '완료', failed: '실패' };
const FLOW_URL = /^https:\/\/(flow\.google\.com|labs\.google\/fx)\//;

let queue = []; // { id, text, status, error, note }
let running = false;

// ---------- 저장/불러오기 ----------
async function load() {
  const data = await chrome.storage.local.get(['queue', 'interval', 'retries', 'split', 'runState', 'autoDuration']);
  queue = data.queue || [];
  running = !!(data.runState && data.runState.running);
  if (data.interval != null) $('interval').value = data.interval;
  if (data.retries != null) $('retries').value = data.retries;
  if (data.autoDuration != null) $('autoDuration').checked = data.autoDuration;
  if (data.split) document.querySelector(`input[name=split][value=${data.split}]`).checked = true;
  render();
}

// 큐는 content.js도 수정하므로 항상 최신 값을 읽은 뒤 바꿔서 저장한다.
async function updateQueue(fn) {
  const { queue: cur = [] } = await chrome.storage.local.get('queue');
  await chrome.storage.local.set({ queue: fn(cur) });
}

function saveSettings() {
  chrome.storage.local.set({
    interval: Number($('interval').value),
    retries: Number($('retries').value),
    autoDuration: $('autoDuration').checked,
    split: document.querySelector('input[name=split]:checked').value,
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.queue) queue = changes.queue.newValue || [];
  if (changes.runState) running = !!(changes.runState.newValue && changes.runState.newValue.running);
  if (changes.queue || changes.runState) render();
});

// ---------- 화면 ----------
function render() {
  const ol = $('queue');
  ol.textContent = '';
  for (const item of queue) {
    const li = document.createElement('li');
    li.className = item.status;
    if (item.status !== 'running') {
      const del = document.createElement('button');
      del.className = 'del';
      del.title = '삭제';
      del.textContent = '×';
      del.onclick = () => updateQueue((q) => q.filter((x) => x.id !== item.id));
      li.append(del);
    }
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = `[${STATUS_TEXT[item.status]}]`;
    li.append(st, document.createTextNode(item.text));
    for (const [cls, text] of [['note', item.note], ['err', item.error]]) {
      if (!text) continue;
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      li.append(span);
    }
    ol.append(li);
  }
  const done = queue.filter((q) => q.status === 'done').length;
  $('count').textContent = queue.length ? `(${done}/${queue.length})` : '';
  $('startBtn').disabled = running || !queue.some((q) => q.status === 'pending');
  $('stopBtn').disabled = !running;
  $('clearBtn').disabled = running;
  $('retryBtn').disabled = !queue.some((q) => q.status === 'failed');
}

function setConn(text, cls) {
  const b = $('conn');
  b.textContent = text;
  b.className = `badge ${cls || ''}`;
}

// ---------- 프롬프트 파싱 ----------
function splitPrompts(text, mode) {
  const parts = mode === 'blank' ? text.split(/\n\s*\n/) : text.split(/\n/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

// UTF-8로 먼저 읽고, 깨지면 EUC-KR(엑셀 기본 CSV)로 다시 읽는다.
function decodeKorean(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  // 헤더에 prompt/프롬프트 열이 있으면 그 열을, 없으면 첫 열을 쓴다.
  const header = rows[0].map((h) => h.trim().toLowerCase());
  let col = header.findIndex((h) => h === 'prompt' || h === '프롬프트');
  const body = col >= 0 ? rows.slice(1) : rows;
  if (col < 0) col = 0;
  return body.map((r) => (r[col] || '').trim()).filter(Boolean);
}

function addPrompts(list) {
  const items = list.map((text) => ({ id: crypto.randomUUID(), text, status: 'pending' }));
  return updateQueue((q) => q.concat(items));
}

// ---------- Flow 탭 연결 ----------
async function getFlowTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && FLOW_URL.test(tab.url || '')) return tab;
  const tabs = await chrome.tabs.query({ url: ['https://flow.google.com/*', 'https://labs.google/fx/*'] });
  return tabs[0] || null;
}

async function send(tab, msg) {
  msg = { ...msg, tabId: tab.id };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // 확장 설치 전에 열려 있던 탭이면 content script를 직접 주입한다.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tab.id, msg);
  }
}

async function checkConnection() {
  const tab = await getFlowTab();
  if (!tab) return setConn('Flow 탭 없음', 'err'), null;
  try {
    const res = await send(tab, { type: 'ping' });
    if (res && res.ready) setConn('Flow 연결됨', 'ok');
    else setConn('프로젝트를 열어 주세요', 'err');
  } catch {
    setConn('연결 실패', 'err');
  }
  return tab;
}

// ---------- 이벤트 ----------
$('addBtn').onclick = async () => {
  const mode = document.querySelector('input[name=split]:checked').value;
  const list = splitPrompts($('prompts').value, mode);
  if (!list.length) return;
  await addPrompts(list);
  $('prompts').value = '';
};

$('importBtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = decodeKorean(await file.arrayBuffer());
  const mode = document.querySelector('input[name=split]:checked').value;
  await addPrompts(/\.csv$/i.test(file.name) ? parseCsv(text) : splitPrompts(text, mode));
  e.target.value = '';
};

$('startBtn').onclick = async () => {
  saveSettings();
  const tab = await checkConnection();
  if (!tab) return alert('Google Flow 프로젝트 탭을 먼저 열어 주세요.');
  const res = await send(tab, { type: 'start' }).catch((e) => ({ ok: false, error: String(e) }));
  if (!res || !res.ok) alert(`시작하지 못했습니다: ${(res && res.error) || ''}`);
};
$('stopBtn').onclick = () => chrome.storage.local.set({ runState: { running: false } });
$('retryBtn').onclick = () =>
  updateQueue((q) => q.map((x) => (x.status === 'failed' ? { ...x, status: 'pending', error: '' } : x)));
$('clearBtn').onclick = () => chrome.storage.local.set({ queue: [] });
$('interval').onchange = saveSettings;
$('retries').onchange = saveSettings;
$('autoDuration').onchange = saveSettings;
document.querySelectorAll('input[name=split]').forEach((r) => (r.onchange = saveSettings));

$('diagBtn').onclick = async () => {
  const tab = await getFlowTab();
  if (!tab) return alert('Flow 탭을 찾지 못했습니다.');
  const res = await send(tab, { type: 'diagnose' });
  await navigator.clipboard.writeText(JSON.stringify(res, null, 2));
  alert('진단 정보를 클립보드에 복사했습니다. 그대로 붙여넣어 보내 주세요.');
};

chrome.tabs.onActivated.addListener(checkConnection);
chrome.tabs.onUpdated.addListener((_id, info) => info.status === 'complete' && checkConnection());

load();
checkConnection();

$('diagSetBtn').onclick = async () => {
  const tab = await getFlowTab();
  if (!tab) return alert('Flow 탭을 찾지 못했습니다.');
  const res = await send(tab, { type: 'diagnoseSettings' });
  await navigator.clipboard.writeText(JSON.stringify(res, null, 2));
  alert('설정 메뉴 진단 정보를 클립보드에 복사했습니다. 그대로 붙여넣어 보내 주세요.');
};
