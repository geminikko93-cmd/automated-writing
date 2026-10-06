// Google Flow 페이지에서 프롬프트 입력·제출을 담당하는 content script.
// 사이드패널이 메시지로 한 단계씩 요청하고, 여기서는 DOM 조작만 한다.
(() => {
  if (window.__flowQueueLoaded) return;
  window.__flowQueueLoaded = true;

  // 버튼은 화면 글자 대신 aria-label로 찾는다. 영어/한국어 화면 모두 대응.
  const LABELS = {
    submit: ['Start generation', 'Generate', 'Create', '생성 시작', '생성', '만들기'],
    clear: ['Clear prompt', '프롬프트 지우기'],
    settings: ['Settings trigger', '설정'],
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  const isDisabled = (el) =>
    !el || el.disabled || el.getAttribute('aria-disabled') === 'true';

  function findButton(names) {
    const lowered = names.map((n) => n.toLowerCase());
    const all = document.querySelectorAll('button, [role="button"]');
    // 정확히 일치하는 것 우선, 없으면 포함하는 것
    for (const exact of [true, false]) {
      for (const el of all) {
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (!aria || !isVisible(el)) continue;
        if (lowered.some((n) => (exact ? aria === n : aria.includes(n)))) return el;
      }
    }
    return null;
  }

  const findSubmit = () => findButton(LABELS.submit);

  const EDITOR_SELECTOR =
    'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';

  // 제출 버튼에서 위로 올라가며 가장 가까운 입력창을 찾는다.
  // 화면 구조나 클래스명이 바뀌어도 "제출 버튼 근처의 입력창"이라는 관계는 잘 안 바뀐다.
  function findEditor() {
    const submit = findSubmit();
    if (submit) {
      let node = submit.parentElement;
      for (let i = 0; node && i < 12; i++, node = node.parentElement) {
        const cands = [...node.querySelectorAll(EDITOR_SELECTOR)].filter(isVisible);
        if (cands.length) return normalizeEditor(cands[0]);
      }
    }
    const any = [...document.querySelectorAll(EDITOR_SELECTOR)].filter(isVisible);
    return any.length ? normalizeEditor(any[any.length - 1]) : null;
  }

  // role=textbox 안쪽에 실제 contenteditable이 있으면 그쪽을 쓴다.
  function normalizeEditor(el) {
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return el;
    return el.querySelector('textarea, [contenteditable="true"]') || el;
  }

  const readEditor = (el) =>
    (el.tagName === 'TEXTAREA' ? el.value : el.innerText || el.textContent || '').trim();

  const normalize = (s) => s.replace(/\s+/g, ' ').trim();

  // 한글이 깨지지 않도록 한 글자씩 타이핑하지 않고 문장 전체를 한 번에 넣는다.
  async function setEditorText(el, text) {
    el.focus();
    await sleep(50);

    // 1) 기존 내용 전체 선택 후 insertText (React/Slate/Lexical 모두 입력 이벤트를 받음)
    if (el.tagName === 'TEXTAREA') {
      el.select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('insertText', false, text);
    await sleep(150);
    if (normalize(readEditor(el)) === normalize(text)) return true;

    // 2) 붙여넣기 이벤트로 재시도
    clearEditor(el);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(150);
    if (normalize(readEditor(el)) === normalize(text)) return true;

    // 3) textarea라면 값 직접 대입 + input 이벤트
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      if (normalize(readEditor(el)) === normalize(text)) return true;
    }
    return false;
  }

  function clearEditor(el) {
    el.focus();
    if (el.tagName === 'TEXTAREA') el.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('delete');
  }

  async function waitFor(fn, timeoutMs, stepMs = 250) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  async function submitPrompt(text, { enableTimeoutMs = 120000 } = {}) {
    const editor = await waitFor(findEditor, 10000);
    if (!editor) return { ok: false, error: '프롬프트 입력창을 찾지 못했습니다.' };

    const inserted = await setEditorText(editor, text);
    if (!inserted) {
      return { ok: false, error: '입력창에 글자를 넣지 못했습니다.', got: readEditor(editor).slice(0, 200) };
    }

    // 동시 생성 개수 제한 등으로 버튼이 잠겨 있으면 풀릴 때까지 기다린다.
    const submit = await waitFor(() => {
      const b = findSubmit();
      return b && !isDisabled(b) ? b : null;
    }, enableTimeoutMs, 500);
    if (!submit) return { ok: false, error: '생성 버튼이 활성화되지 않았습니다.' };

    submit.click();

    // 제출 확인: 입력창이 비거나 버튼이 잠기면 제출된 것으로 본다.
    const accepted = await waitFor(() => {
      const ed = findEditor();
      const b = findSubmit();
      return (ed && readEditor(ed) === '') || isDisabled(b);
    }, 15000, 250);
    if (!accepted) return { ok: false, error: '버튼을 눌렀지만 제출이 확인되지 않았습니다.' };
    return { ok: true };
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      contenteditable: el.getAttribute('contenteditable'),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
      classes: (el.className && el.className.baseVal === undefined ? el.className : '').slice(0, 120),
      text: (el.innerText || el.value || '').trim().slice(0, 80),
      disabled: isDisabled(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  }

  function diagnose() {
    const editor = findEditor();
    const submit = findSubmit();
    const settings = findButton(LABELS.settings);
    return {
      href: location.href,
      title: document.title,
      editor: editor ? describe(editor) : null,
      submit: submit ? describe(submit) : null,
      settings: settings ? describe(settings) : null,
      editorCandidates: [...document.querySelectorAll(EDITOR_SELECTOR)].filter(isVisible).map(describe),
      buttonsWithAria: [...document.querySelectorAll('button, [role="button"]')]
        .filter((b) => isVisible(b) && b.getAttribute('aria-label'))
        .map((b) => ({ aria: b.getAttribute('aria-label'), text: b.innerText.trim().slice(0, 40), disabled: isDisabled(b) })),
    };
  }

  // ---------- 큐 실행 (패널을 닫아도 페이지에서 계속 돈다) ----------
  // 상태는 chrome.storage.local에 두고, 사이드패널은 화면 표시만 한다.
  let looping = false;

  const getStore = (keys) => chrome.storage.local.get(keys);
  const setStore = (obj) => chrome.storage.local.set(obj);

  // 항목 하나만 바꿔 저장한다. 그 사이 패널에서 추가한 항목이 지워지지 않도록 매번 새로 읽는다.
  async function patchItem(id, patch) {
    const { queue = [] } = await getStore('queue');
    const item = queue.find((q) => q.id === id);
    if (item) Object.assign(item, patch);
    await setStore({ queue });
  }

  async function shouldStop() {
    const { runState } = await getStore('runState');
    return !runState || !runState.running || runState.tabId !== myTabId;
  }

  async function sleepUnlessStopped(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await shouldStop()) return;
      await sleep(Math.min(500, end - Date.now()));
    }
  }

  // 제출 직후 Flow가 띄운 안내/오류 문구를 모은다 (예: 동시 생성 개수 초과).
  const alertTexts = () =>
    new Set(
      [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')]
        .map((el) => (el.innerText || '').trim())
        .filter(Boolean)
    );

  async function runLoop() {
    if (looping) return;
    looping = true;
    try {
      for (;;) {
        if (await shouldStop()) break;
        const { queue = [], interval = 10, retries = 2 } = await getStore(['queue', 'interval', 'retries']);
        const item = queue.find((q) => q.status === 'pending');
        if (!item) break;

        await patchItem(item.id, { status: 'running', error: '', note: '' });
        const before = alertTexts();
        let res;
        for (let attempt = 0; attempt <= retries; attempt++) {
          res = await submitPrompt(item.text).catch((e) => ({ ok: false, error: String(e) }));
          if (res.ok || (await shouldStop())) break;
          await sleep(3000);
        }
        await sleep(1500);
        const fresh = [...alertTexts()].filter((t) => !before.has(t)).join(' / ').slice(0, 300);

        if (res.ok) await patchItem(item.id, { status: 'done', note: fresh ? `Flow 메시지: ${fresh}` : '' });
        else await patchItem(item.id, { status: 'failed', error: res.error + (fresh ? ` (Flow 메시지: ${fresh})` : '') });

        const { queue: after = [] } = await getStore('queue');
        if (after.some((q) => q.status === 'pending')) await sleepUnlessStopped(Math.max(0, Number(interval) || 0) * 1000);
      }
    } finally {
      looping = false;
      const { runState } = await getStore('runState');
      if (runState && runState.tabId === myTabId) await setStore({ runState: { running: false } });
    }
  }

  let myTabId = null;

  // 페이지를 새로고침해도 실행 중이었다면 이어서 진행한다.
  // 새로고침 직전에 진행 중이던 항목은 제출됐는지 알 수 없으므로 중복 생성을 막기 위해 실패로 표시한다.
  async function resumeIfNeeded() {
    const { runState, queue = [] } = await getStore(['runState', 'queue']);
    if (!runState || !runState.running || runState.tabId !== myTabId) return;
    let changed = false;
    for (const q of queue) {
      if (q.status === 'running') {
        q.status = 'failed';
        q.error = '실행 중 페이지가 새로고침되어 중단됨. Flow에서 생성 여부를 확인한 뒤 필요하면 다시 시도하세요.';
        changed = true;
      }
    }
    if (changed) await setStore({ queue });
    await waitFor(findSubmit, 20000, 500);
    runLoop();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.tabId != null) myTabId = msg.tabId;
        if (msg.type === 'ping') return { ok: true, ready: !!findSubmit(), looping };
        if (msg.type === 'start') {
          await setStore({ runState: { running: true, tabId: myTabId } });
          runLoop();
          return { ok: true };
        }
        if (msg.type === 'submit') return await submitPrompt(msg.text, msg.options);
        if (msg.type === 'diagnose') return { ok: true, details: diagnose() };
        return { ok: false, error: '알 수 없는 요청' };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    })().then(sendResponse);
    return true;
  });

  chrome.runtime.sendMessage({ type: 'whoami' }).then((res) => {
    if (res && res.tabId != null) {
      myTabId = res.tabId;
      resumeIfNeeded();
    }
  }).catch(() => {});
})();
