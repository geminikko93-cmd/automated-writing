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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'ping') return { ok: true, ready: !!findSubmit() };
        if (msg.type === 'submit') return await submitPrompt(msg.text, msg.options);
        if (msg.type === 'diagnose') return { ok: true, details: diagnose() };
        return { ok: false, error: '알 수 없는 요청' };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    })().then(sendResponse);
    return true;
  });
})();
