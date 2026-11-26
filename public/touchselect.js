'use strict';
// ── 모바일: 터미널 화면에서 길게 눌러 바로 선택·복사 ──
// 길게 누르기 → 누른 단어 선택 (손을 떼지 않고 끌면 선택 확장)
// 양 끝 손잡이를 끌어 범위 조절, 위쪽 도구 막대에서 복사 / 줄 단위 / 전체(복사 창) / 닫기
// 선택 중 탭하면 선택 해제 (키보드는 열지 않음), 끌면 평소처럼 스크롤
// xterm 자체 선택(term.select)을 쓰므로 tmux·vim 같은 전체 화면 프로그램에서도 화면 글자를 고를 수 있다.
// eslint-disable-next-line no-unused-vars
function setupTouchSelect(term, el, wrap, { onCopy, onOpenAll, onTap } = {}) {
  const LONG_MS = 450;
  // 손가락 떨림 허용 범위 (화면 기준 px). 터치 기본 동작을 꺼서 브라우저가 걸러 주던 미세한 움직임까지 들어오므로
  // 넉넉히 잡고, 데스크톱 모드 확대(mobilefix.js) 중이면 좌표가 배율만큼 커지므로 곱해 준다
  const MOVE_TOL = 16;
  const tol = () => MOVE_TOL * (window.uiZoom || 1);
  let a = null; // 선택 시작 {x, y} (y 는 버퍼 절대 줄)
  let b = null; // 선택 끝 (포함)
  let active = false;
  let applying = false;
  let timer = null;
  let start = null; // 이번 터치 시작 위치
  let dragSel = false; // 길게 누른 뒤 손을 떼지 않고 끄는 중
  let tapClear = false; // 선택 중 탭 → 해제 후보
  let handleDrag = null; // 'a' | 'b'
  let lastTouch = 0;
  let moved = false;
  let longFired = false;
  let word0 = null; // 길게 눌러 처음 고른 단어 [시작, 끝]
  let dragMoved = false;

  const ui = document.createElement('div');
  ui.className = 'tsel-ui';
  ui.hidden = true;
  ui.innerHTML =
    '<div class="tsel-bar">' +
    '<button type="button" data-t="copy" class="primary">복사</button>' +
    '<button type="button" data-t="line">줄 단위</button>' +
    '<button type="button" data-t="all">전체…</button>' +
    '<button type="button" data-t="close" aria-label="선택 닫기">✕</button>' +
    '</div>' +
    '<div class="tsel-h" data-h="a"><i></i></div><div class="tsel-h" data-h="b"><i></i></div>';
  wrap.appendChild(ui);
  const bar = ui.querySelector('.tsel-bar');
  const hA = ui.querySelector('[data-h="a"]');
  const hB = ui.querySelector('[data-h="b"]');

  const buf = () => term.buffer.active;
  const screenEl = () => term.element && term.element.querySelector('.xterm-screen');
  const cmp = (p, q) => (p.y - q.y) || (p.x - q.x);

  // 화면 좌표 → 칸 (화면 밖이면 가장자리 칸으로)
  function cellAt(cx, cy) {
    const r = screenEl().getBoundingClientRect();
    const cw = r.width / term.cols;
    const ch = r.height / term.rows;
    const x = Math.min(term.cols - 1, Math.max(0, Math.floor((cx - r.left) / cw)));
    const row = Math.min(term.rows - 1, Math.max(0, Math.floor((cy - r.top) / ch)));
    return { x, y: buf().viewportY + row, over: cy < r.top ? -1 : cy > r.bottom ? 1 : 0 };
  }
  function cellChar(line, i) {
    const c = line && line.getCell(i);
    if (!c) return ' ';
    if (c.getWidth() === 0) return 'W'; // 넓은 글자(한글 등)의 뒷칸
    return c.getChars() || ' ';
  }
  const isWord = (line, i) => i >= 0 && i < term.cols && !/\s/.test(cellChar(line, i));
  function wordAt(p) {
    const line = buf().getLine(p.y);
    let s = p.x;
    let e = p.x;
    if (isWord(line, p.x)) {
      while (isWord(line, s - 1)) s--;
      while (isWord(line, e + 1)) e++;
    }
    return [{ x: s, y: p.y }, { x: e, y: p.y }];
  }

  function apply() {
    if (!a || !b) return;
    let s = a;
    let e = b;
    if (cmp(s, e) > 0) [s, e] = [e, s];
    s = { ...s };
    e = { ...e };
    // 넓은 글자 반쪽만 잡히지 않게
    const ls = buf().getLine(s.y);
    if (s.x > 0 && ls && ls.getCell(s.x) && ls.getCell(s.x).getWidth() === 0) s.x--;
    const le = buf().getLine(e.y);
    if (le && le.getCell(e.x) && le.getCell(e.x).getWidth() === 2) e.x++;
    const len = (e.y - s.y) * term.cols + (e.x - s.x) + 1;
    applying = true;
    try { term.select(s.x, s.y, Math.max(1, len)); } finally { applying = false; }
    place();
  }

  // 선택 중에는 키보드를 띄우지 않는다: 입력칸에 포커스가 남아 있으면(키보드를 내려도 포커스는 남음) 풀고,
  // 선택하는 동안 어떤 경로로든 입력칸에 포커스가 오면 바로 푼다
  const isTyping = (el2) => el2 && /^(INPUT|TEXTAREA)$/.test(el2.tagName) && !el2.closest('dialog');
  document.addEventListener('focusin', (ev) => { if ((active || dragSel) && isTyping(ev.target)) ev.target.blur(); });
  function begin(p) {
    if (isTyping(document.activeElement)) document.activeElement.blur();
    [a, b] = wordAt(p);
    active = true;
    ui.hidden = false;
    apply();
    try { navigator.vibrate && navigator.vibrate(12); } catch { /* 무시 */ }
  }
  function end() {
    if (!active) return;
    active = false;
    a = b = null;
    dragSel = handleDrag = null;
    ui.hidden = true;
    applying = true;
    try { term.clearSelection(); } finally { applying = false; }
  }

  // 손잡이·도구 막대 위치 (wrap 기준 CSS px, 데스크톱 모드 확대 배율 보정)
  function place() {
    if (!active) return;
    const sc = screenEl();
    if (!sc) return;
    const wr = wrap.getBoundingClientRect();
    const k = wr.width / (wrap.offsetWidth || wr.width) || 1;
    const r = sc.getBoundingClientRect();
    const ox = (r.left - wr.left) / k;
    const oy = (r.top - wr.top) / k;
    const cw = r.width / k / term.cols;
    const ch = r.height / k / term.rows;
    let s = a;
    let e = b;
    if (cmp(s, e) > 0) [s, e] = [e, s];
    const vy = buf().viewportY;
    const put = (h, p, right) => {
      const row = p.y - vy;
      h.hidden = row < 0 || row >= term.rows;
      h.style.left = ox + (p.x + (right ? 1 : 0)) * cw + 'px';
      h.style.top = oy + (row + 1) * ch + 'px';
      h.dataset.side = right ? 'r' : 'l';
    };
    // a/b 중 앞쪽이 왼쪽 손잡이
    put(cmp(a, b) <= 0 ? hA : hB, s, false);
    put(cmp(a, b) <= 0 ? hB : hA, e, true);
    // 도구 막대: 선택이 화면 위쪽에 있으면 아래에 둔다
    const topRow = s.y - vy;
    bar.classList.toggle('bottom', topRow >= 0 && topRow < 3);
  }

  // ── 터미널 위 터치 (capture 단계: 선택 동작일 때만 스크롤 처리기로 넘기지 않음) ──
  const stop = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); }; // 같은 #term 의 스크롤 처리기도 건너뜀
  // 브라우저 기본 터치 동작(길게 누르기 메뉴·붙여넣기 팝업·텍스트 선택)은 끄고, 탭은 tapAt 이 직접 처리한다
  el.addEventListener('touchstart', (ev) => {
    lastTouch = Date.now();
    clearTimeout(timer);
    if (ev.cancelable) ev.preventDefault();
    if (ev.touches.length !== 1) { start = null; return; }
    const t = ev.touches[0];
    start = { x: t.clientX, y: t.clientY };
    dragSel = false;
    moved = false;
    longFired = false;
    tapClear = active;
    timer = setTimeout(() => {
      timer = null;
      if (!start) return;
      longFired = true;
      begin(cellAt(start.x, start.y));
      word0 = [a, b];
      dragMoved = false;
      dragSel = true;
      tapClear = false;
    }, LONG_MS);
  }, { capture: true, passive: false });
  el.addEventListener('touchmove', (ev) => {
    if (!start || ev.touches.length !== 1) return;
    const t = ev.touches[0];
    if (dragSel) {
      stop(ev);
      // 떨림 정도로는 처음 고른 단어를 유지하고, 확실히 끌었을 때만 넓힌다 (단어는 항상 포함)
      if (!dragMoved && Math.hypot(t.clientX - start.x, t.clientY - start.y) <= tol()) return;
      dragMoved = true;
      const p = cellAt(t.clientX, t.clientY);
      edgeScroll(p.over);
      const [ws, we] = word0;
      if (cmp(p, ws) < 0) { a = { x: p.x, y: p.y }; b = we; } else { a = ws; b = cmp(p, we) > 0 ? { x: p.x, y: p.y } : we; }
      apply();
      return;
    }
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > tol()) {
      moved = true;
      clearTimeout(timer);
      timer = null;
      tapClear = false; // 스크롤: 선택은 그대로 두고 평소처럼 스크롤
    }
  }, { capture: true, passive: false });
  el.addEventListener('touchend', (ev) => {
    clearTimeout(timer);
    timer = null;
    if (dragSel) { dragSel = false; start = null; stop(ev); return; }
    if (tapClear) { tapClear = false; start = null; end(); stop(ev); return; }
    // 그냥 탭: 기본 동작을 껐으므로 마우스 클릭(tmux 창 고르기 등)과 포커스(키보드)를 직접 만든다
    if (start && !moved && !longFired && ev.cancelable) {
      ev.preventDefault();
      tapAt(start.x, start.y);
    }
    start = null;
  }, { capture: true, passive: false });
  function tapAt(x, y) {
    const sc = screenEl();
    if (sc) {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        sc.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0 }));
      }
    }
    if (onTap) onTap();
  }
  el.addEventListener('touchcancel', () => { clearTimeout(timer); timer = null; start = null; dragSel = false; }, { capture: true });
  // xterm 자체 터치 스크롤(픽셀 단위)은 끈다: 앱 스크롤(setupTouchScroll)과 따로 움직여 손가락 떨림에도 화면이 밀림.
  // #term 의 capture 처리기들이 먼저 실행된 뒤 xterm 요소에서 전파를 멈춘다
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    term.element.addEventListener(type, (ev) => ev.stopPropagation(), { capture: true, passive: true });
  }
    // 길게 누를 때 브라우저 기본 메뉴(이미지 저장 등) 막기
  el.addEventListener('contextmenu', (ev) => { if (Date.now() - lastTouch < 1500) ev.preventDefault(); });

  // 선택을 끌다가 화면 위/아래 끝을 넘어가면 기록을 스크롤 (일반 셸만)
  let lastEdge = 0;
  function edgeScroll(over) {
    if (!over || buf().type !== 'normal') return;
    const now = Date.now();
    if (now - lastEdge < 60) return;
    lastEdge = now;
    term.scrollLines(over);
  }

  // ── 손잡이 끌기 ──
  // 잡은 지점과 손잡이가 가리키는 글자 칸 사이 거리를 기억해 두고 그만큼 빼서 계산한다
  // (손가락으로 글자를 가리지 않고, 잡자마자 선택이 한 줄 튀지 않게)
  let grab = { dx: 0, dy: 0 };
  for (const h of [hA, hB]) {
    h.addEventListener('touchstart', (ev) => {
      stop(ev);
      if (ev.touches.length !== 1) return;
      handleDrag = h.dataset.h;
      const p = handleDrag === 'a' ? a : b;
      const r = screenEl().getBoundingClientRect();
      const cw = r.width / term.cols;
      const ch = r.height / term.rows;
      const t = ev.touches[0];
      grab = {
        dx: t.clientX - (r.left + (p.x + 0.5) * cw),
        dy: t.clientY - (r.top + (p.y - buf().viewportY + 0.5) * ch),
      };
    }, { passive: false });
    h.addEventListener('touchmove', (ev) => {
      if (!handleDrag || ev.touches.length !== 1) return;
      stop(ev);
      const t = ev.touches[0];
      const p = cellAt(t.clientX - grab.dx, t.clientY - grab.dy);
      edgeScroll(p.over);
      if (handleDrag === 'a') a = { x: p.x, y: p.y }; else b = { x: p.x, y: p.y };
      apply();
    }, { passive: false });
    const done = (ev) => { if (handleDrag) { stop(ev); handleDrag = null; } };
    h.addEventListener('touchend', done, { passive: false });
    h.addEventListener('touchcancel', done, { passive: false });
    h.addEventListener('mousedown', (ev) => ev.preventDefault());
  }

  // ── 도구 막대 ──
  bar.addEventListener('mousedown', (ev) => ev.preventDefault()); // 터미널 포커스·키보드 열림 방지
  bar.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn || !active) return;
    const act = btn.dataset.t;
    if (act === 'copy') {
      const text = term.getSelection();
      if (text && onCopy && (await onCopy(text)) !== false) end();
    } else if (act === 'line') {
      if (cmp(a, b) > 0) [a, b] = [b, a];
      a = { x: 0, y: a.y };
      b = { x: term.cols - 1, y: b.y };
      apply();
    } else if (act === 'all') {
      end();
      if (onOpenAll) onOpenAll();
    } else if (act === 'close') {
      end();
    }
  });

  term.onSelectionChange(() => { if (active && !applying && !term.hasSelection()) end(); });
  term.onRender(() => place());
  term.onScroll(() => place());
  term.onResize(() => end());
  if (term.buffer.onBufferChange) term.buffer.onBufferChange(() => end());

  return { active: () => active, end };
}
