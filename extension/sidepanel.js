// 사이드패널: 큐 관리와 실행 루프. 실제 DOM 조작은 content.js가 한다.
const $ = (id) => document.getElementById(id);
const STATUS_TEXT = { pending: '대기', running: '진행 중', done: '완료', failed: '실패' };
const FLOW_URL = /^https:\/\/(flow\.google\.com|labs\.google\/fx)\//;

let queue = []; // { id, text, status, error }
let running = false;
let stopRequested = false;

// ---------- 저장/불러오기 ----------
async function load() {
  const data = await chrome.storage.local.get(['queue', 'interval', 'retries', 'split']);
  // 진행 중이던 항목은 패널을 다시 열면 대기로 되돌린다.
  queue = (data.queue || []).map((q) => (q.status === 'running' ? { ...q, status: 'pending' } : q));
  if (data.interval != null) $('interval').value = data.interval;
  if (data.retries != null) $('retries').value = data.retries;
  if (data.split) document.querySelector(`input[name=split][value=${data.split}]`).checked = true;
  render();
}

function save() {
  chrome.storage.local.set({
    queue,
    interval: Number($('interval').value),
    retries: Number($('retries').value),
    split: document.querySelector('input[name=split]:checked').value,
  });
}

// ---------- 화면 ----------
function render() {
  const ol = $('queue');
  ol.textContent = '';
  for (const item of queue) {
    const li = document.createElement('li');
    li.className = item.status;
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = `[${STATUS_TEXT[item.status]}]`;
    li.append(st, document.createTextNode(item.text));
    if (!running) {
      const del = document.createElement('button');
      del.className = 'del';
      del.title = '삭제';
      del.textContent = '×';
      del.onclick = () => { queue = queue.filter((q) => q.id !== item.id); save(); render(); };
      li.prepend(del);
    }
    if (item.error) {
      const e = document.createElement('span');
      e.className = 'err';
      e.textContent = item.error;
      li.append(e);
    }
    ol.append(li);
  }
  const done = queue.filter((q) => q.status === 'done').length;
  $('count').textContent = queue.length ? `(${done}/${queue.length})` : '';
  $('startBtn').disabled = running || !queue.some((q) => q.status !== 'done');
  $('stopBtn').disabled = !running;
  $('clearBtn').disabled = running;
  $('addBtn').disabled = running;
}

function setConn(text, cls) {
  const b = $('conn');
  b.textContent = text;
  b.className = `badge ${cls || ''}`;
}

// ---------- 프롬프트 파싱 ----------
function splitPrompts(text, mode) {
  const parts = mode === 'blank' ? text.split(/\n\s*\n/) : text.split(/\n/);
  return parts.map((s) => s.replace(/\s+$/g, '').trim()).filter(Boolean);
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
  for (const text of list) queue.push({ id: crypto.randomUUID(), text, status: 'pending' });
  save();
  render();
}

// ---------- Flow 탭 연결 ----------
async function getFlowTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && FLOW_URL.test(tab.url || '')) return tab;
  const tabs = await chrome.tabs.query({ url: ['https://flow.google.com/*', 'https://labs.google/fx/*'] });
  return tabs[0] || null;
}

async function send(tab, msg) {
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

// ---------- 실행 루프 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sleepUnlessStopped(ms) {
  const end = Date.now() + ms;
  while (!stopRequested && Date.now() < end) await sleep(200);
}

async function run() {
  const tab = await checkConnection();
  if (!tab) return alert('Google Flow 프로젝트 탭을 먼저 열어 주세요.');

  running = true;
  stopRequested = false;
  save();
  render();

  const intervalMs = Math.max(0, Number($('interval').value) || 0) * 1000;
  const retries = Math.max(0, Number($('retries').value) || 0);

  for (const item of queue) {
    if (stopRequested) break;
    if (item.status === 'done') continue;
    item.status = 'running';
    item.error = '';
    render();

    let res;
    for (let attempt = 0; attempt <= retries && !stopRequested; attempt++) {
      res = await send(tab, { type: 'submit', text: item.text }).catch((e) => ({ ok: false, error: String(e) }));
      if (res && res.ok) break;
      await sleepUnlessStopped(3000);
    }

    if (res && res.ok) item.status = 'done';
    else if (stopRequested) item.status = 'pending';
    else { item.status = 'failed'; item.error = (res && res.error) || '알 수 없는 오류'; }
    save();
    render();

    if (queue.some((q) => q.status === 'pending')) await sleepUnlessStopped(intervalMs);
  }

  running = false;
  save();
  render();
}

// ---------- 이벤트 ----------
$('addBtn').onclick = () => {
  const mode = document.querySelector('input[name=split]:checked').value;
  const list = splitPrompts($('prompts').value, mode);
  if (!list.length) return;
  addPrompts(list);
  $('prompts').value = '';
};

$('importBtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = decodeKorean(await file.arrayBuffer());
  const mode = document.querySelector('input[name=split]:checked').value;
  addPrompts(/\.csv$/i.test(file.name) ? parseCsv(text) : splitPrompts(text, mode));
  e.target.value = '';
};

$('startBtn').onclick = run;
$('stopBtn').onclick = () => { stopRequested = true; $('stopBtn').disabled = true; };
$('clearBtn').onclick = () => { queue = []; save(); render(); };
$('interval').onchange = save;
$('retries').onchange = save;
document.querySelectorAll('input[name=split]').forEach((r) => (r.onchange = save));

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
