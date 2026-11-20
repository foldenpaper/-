/* 今天吃什么 —— 转盘逻辑
 *
 * 角度约定（全文件统一）：
 *   - 12 点钟方向为 0°，角度沿顺时针增加。
 *   - 扇区 i（0 ~ N-1）占据 [i * slice, (i + 1) * slice)，slice = 360 / N。
 *   - 极坐标转 SVG 坐标：x = cx + r·sinθ，y = cy − r·cosθ（SVG 的 y 轴向下）。
 *   - 转盘固定不动；勺子指针初始指向 0°，用 CSS rotate(P) 顺时针转动 P 度。
 *     此时指针指向转盘上的角度 P mod 360。
 */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */

  // 内置的 4 个转盘（不能删除，可以改选项、可以恢复默认）
  var BUILTINS = [
    { id: 'main',  name: '正餐',   defaults: ['火锅', '烧烤', '面食', '炒菜', '饺子', '日料'] },
    { id: 'light', name: '轻食',   defaults: ['沙拉', '三明治', '饭团', '寿司卷', '粥', '酸奶碗'] },
    { id: 'night', name: '宵夜',   defaults: ['拉面', '烤串', '炸鸡', '麻辣烫', '关东煮', '炒饭'] },
    { id: 'tea',   name: '下午茶', defaults: ['奶茶', '蛋糕', '咖啡', '甜甜圈', '布丁', '水果'] }
  ];
  // 奶油色双色交替；项数为奇数时最后一格用第三色，避免首尾同色相邻
  var TONES = ['#fde3c3', '#fff2df', '#fbeacb'];
  var WIN_COLOR = '#ffc690';
  function sliceColor(i, n) { return (n % 2 === 1 && i === n - 1) ? TONES[2] : TONES[i % 2]; }
  var MIN_ITEMS = 2, MAX_ITEMS = 12, MAX_LEN = 8;
  var MAX_CUSTOM = 10, MAX_NAME = 6;
  var HISTORY_SIZE = 5;
  var FULL_TURNS = 5;
  var EASING = 'cubic-bezier(0.15, 0.85, 0.25, 1)';
  var STORAGE_KEY = 'what-to-eat:v1';
  var SHARE_PREFIX = '#m=';

  var params = new URLSearchParams(location.search);
  var DEBUG = params.get('debug') === '1';
  var reducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // ?spinms=xx 仅用于自动化测试加速
  var SPIN_MS = Number(params.get('spinms')) || (reducedMotion ? 800 : 2000);
  var FALLBACK_MS = SPIN_MS + 500;

  var CX = 100, CY = 100, R = 100;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var $ = function (id) { return document.getElementById(id); };
  var wheelEl = $('wheel'), pointerEl = $('pointer');
  var spinBtn = $('spin'), resultEl = $('result'), debugEl = $('debug'), installBtn = $('install');
  var tabsEl = $('tabs'), mascotEl = $('mascot');
  var soundBtn = $('btn-sound'), editBtn = $('btn-edit'), historyBtn = $('btn-history'), shareBtn = $('btn-share');

  /* ---------- 校验工具 ---------- */

  function cleanText(s, maxLen) {
    return typeof s === 'string' ? s.trim().slice(0, maxLen) : '';
  }

  /** 校验选项列表，返回问题描述；没问题返回 null */
  function findProblem(list) {
    if (list.length < MIN_ITEMS) return '至少需要 ' + MIN_ITEMS + ' 项';
    if (list.length > MAX_ITEMS) return '最多 ' + MAX_ITEMS + ' 项';
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var s = typeof list[i] === 'string' ? list[i].trim() : '';
      if (!s) return '第 ' + (i + 1) + ' 项不能为空';
      if (s.length > MAX_LEN) return '「' + s + '」太长了，最多 ' + MAX_LEN + ' 个字';
      if (seen[s]) return '「' + s + '」重复了';
      seen[s] = true;
    }
    return null;
  }

  function isValidList(list) { return Array.isArray(list) && findProblem(list) === null; }

  function newId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /** 把外部数据（本地存储或分享链接）整理成合法的 { lists, custom }，不合法的部分丢弃 */
  function normalizeMenus(lists, custom) {
    var out = { lists: {}, custom: [] };
    BUILTINS.forEach(function (b) {
      var l = lists && lists[b.id];
      out.lists[b.id] = isValidList(l) ? l.map(function (s) { return s.trim(); }) : b.defaults.slice();
    });
    var names = BUILTINS.map(function (b) { return b.name; });
    (Array.isArray(custom) ? custom : []).forEach(function (c) {
      if (!c || out.custom.length >= MAX_CUSTOM) return;
      var name = cleanText(c.name, MAX_NAME);
      if (!name || names.indexOf(name) >= 0 || !isValidList(c.items)) return;
      names.push(name);
      out.custom.push({
        id: typeof c.id === 'string' && /^c[a-z0-9]{1,20}$/.test(c.id) ? c.id : newId(),
        name: name,
        items: c.items.map(function (s) { return s.trim(); })
      });
    });
    return out;
  }

  /* ---------- 状态与本地存储 ---------- */

  function loadState() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { /* 数据损坏时用默认值 */ }
    if (!saved || typeof saved !== 'object') saved = {};
    var menus = normalizeMenus(saved.lists, saved.custom);
    var st = {
      current: 'main',
      lists: menus.lists,
      custom: menus.custom,
      history: [],
      sound: saved.sound === true
    };
    var cur = saved.current || saved.category; // 兼容旧版本的字段名
    if (typeof cur === 'string') st.current = cur;
    if (Array.isArray(saved.history)) st.history = saved.history.filter(function (h) {
      return h && typeof h.label === 'string' && typeof h.t === 'number';
    }).slice(0, HISTORY_SIZE);
    return st;
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略 */ }
  }

  var state = loadState();
  var currentRotation = 0;
  var isSpinning = false;
  var spinId = 0;
  var lastSpin = null;

  /** 全部转盘：内置在前，自定义在后 */
  function allWheels() {
    var list = BUILTINS.map(function (b) {
      return { id: b.id, name: b.name, items: state.lists[b.id], builtin: true, defaults: b.defaults };
    });
    state.custom.forEach(function (c) {
      list.push({ id: c.id, name: c.name, items: c.items, builtin: false });
    });
    return list;
  }

  function getWheel(id) {
    var all = allWheels();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function currentWheel() {
    var w = getWheel(state.current);
    if (!w) { state.current = 'main'; w = getWheel('main'); }
    return w;
  }
  function options() { return currentWheel().items; }

  function resultText(wheel, label) {
    return wheel.builtin ? '今天，吃' + label + '吧' : '就决定是「' + label + '」啦';
  }
  function idleText(wheel) {
    return wheel.builtin ? '今天，吃什么好呢' : wheel.name + '，选哪个好呢';
  }

  /* ---------- 纯函数：角度算法 ---------- */

  function polar(angleDeg, radius) {
    var a = angleDeg * Math.PI / 180;
    return { x: CX + radius * Math.sin(a), y: CY - radius * Math.cos(a) };
  }

  /** 让指针停在 targetIndex 扇区内所需的新累计角度（只正向转） */
  function computeNextRotation(current, targetIndex, n, rand) {
    var slice = 360 / n;
    var offset = (0.2 + rand() * 0.6) * slice; // 避开分界线
    var targetMod = targetIndex * slice + offset;
    var delta = ((targetMod - (current % 360)) + 360) % 360;
    return current + 360 * FULL_TURNS + delta;
  }

  /** 由指针累计角度反算指向的扇区 */
  function resolveIndex(rotation, n) {
    var slice = 360 / n;
    var pointed = ((rotation % 360) + 360) % 360;
    return Math.floor(pointed / slice) % n;
  }

  /* ---------- 绘制 ---------- */

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function fontSizeFor(n, label) {
    var base = n <= 6 ? 13 : n <= 8 ? 12 : n <= 10 ? 11 : 10;
    if (label.length > 3) base -= 1;
    if (label.length > 4) base -= 1.5;
    return base;
  }

  function renderWheel() {
    var list = options();
    var n = list.length;
    var slice = 360 / n;
    while (wheelEl.firstChild) wheelEl.removeChild(wheelEl.firstChild);

    for (var i = 0; i < n; i++) {
      var a0 = i * slice, a1 = (i + 1) * slice;
      var p0 = polar(a0, R), p1 = polar(a1, R);
      // sweep-flag = 1：在 SVG 屏幕坐标中沿顺时针画弧
      wheelEl.appendChild(svgEl('path', {
        d: 'M ' + CX + ' ' + CY +
           ' L ' + p0.x.toFixed(3) + ' ' + p0.y.toFixed(3) +
           ' A ' + R + ' ' + R + ' 0 ' + (slice > 180 ? 1 : 0) + ' 1 ' + p1.x.toFixed(3) + ' ' + p1.y.toFixed(3) + ' Z',
        fill: sliceColor(i, n), stroke: '#fffaf0', 'stroke-width': 1, 'data-index': i
      }));

      // 转盘不动，文字横排放在扇区中线上
      var label = list[i];
      var pos = polar(a0 + slice / 2, R * 0.83);
      var text = svgEl('text', {
        x: pos.x.toFixed(2), y: pos.y.toFixed(2), 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': fontSizeFor(n, label), 'data-index': i
      });
      text.textContent = label.length > 6 ? label.slice(0, 5) + '…' : label;
      wheelEl.appendChild(text);
    }
    wheelEl.appendChild(svgEl('circle', { cx: CX, cy: CY, r: R - 0.8, fill: 'none', stroke: '#e9c793', 'stroke-width': 1.6 }));
  }

  function highlight(index) {
    var n = options().length;
    Array.prototype.forEach.call(wheelEl.querySelectorAll('path'), function (p) {
      var i = Number(p.getAttribute('data-index'));
      p.setAttribute('fill', i === index ? WIN_COLOR : sliceColor(i, n));
    });
    Array.prototype.forEach.call(wheelEl.querySelectorAll('text'), function (t) {
      t.classList.toggle('win', Number(t.getAttribute('data-index')) === index);
    });
  }

  function renderTabs() {
    while (tabsEl.firstChild) tabsEl.removeChild(tabsEl.firstChild);
    var cur = currentWheel();
    var selected = null;
    allWheels().forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(w.id === cur.id));
      b.dataset.cat = w.id;
      b.textContent = w.name;
      b.disabled = isSpinning;
      b.addEventListener('click', function () { switchWheel(w.id); });
      tabsEl.appendChild(b);
      if (w.id === cur.id) selected = b;
    });
    $('tab-add').disabled = isSpinning || state.custom.length >= MAX_CUSTOM;
    if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function setMascot(mood) {
    mascotEl.dataset.mood = mood;
  }

  function showIdleResult(text) {
    resultEl.classList.remove('show');
    resultEl.textContent = text;
  }

  /** 转盘内容变了（切换、编辑、导入）后统一刷新 */
  function refreshAll(message) {
    renderTabs();
    renderWheel();
    setMascot('idle');
    showIdleResult(message || idleText(currentWheel()));
    lastSpin = null;
    updateDebug();
  }

  function switchWheel(id) {
    if (isSpinning || id === state.current || !getWheel(id)) return;
    state.current = id;
    saveState();
    refreshAll();
  }

  /* ---------- 提示 ---------- */

  var toastEl = $('toast'), toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  /* ---------- 音效（Web Audio 合成，无外部文件） ---------- */

  var audioCtx = null;
  function ensureAudio() {
    if (!state.sound) return null;
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function beep(freq, start, dur, type, vol) {
    var ctx = audioCtx;
    var osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + dur + 0.02);
  }

  var lastTickAt = 0;
  function playTick() {
    if (!state.sound || !audioCtx) return;
    var now = performance.now();
    if (now - lastTickAt < 35) return;
    lastTickAt = now;
    beep(1500, 0, 0.035, 'triangle', 0.12);
  }

  function playChime() {
    if (!state.sound || !audioCtx) return;
    beep(880, 0, 0.14, 'sine', 0.18);
    beep(1320, 0.11, 0.22, 'sine', 0.16);
  }

  // 转动中逐帧读取实际角度，每经过一条分界线响一下
  function startTickLoop(id, n) {
    if (!state.sound) return;
    var lastIdx = null;
    (function frame() {
      if (id !== spinId || !isSpinning) return;
      var m = getComputedStyle(pointerEl).transform;
      var match = m && m.match(/matrix\(([^,]+),\s*([^,]+)/);
      if (match) {
        var angle = Math.atan2(parseFloat(match[2]), parseFloat(match[1])) * 180 / Math.PI;
        var idx = resolveIndex(angle, n);
        if (lastIdx !== null && idx !== lastIdx) playTick();
        lastIdx = idx;
      }
      requestAnimationFrame(frame);
    })();
  }

  function renderSoundBtn() {
    soundBtn.setAttribute('aria-pressed', String(state.sound));
    soundBtn.setAttribute('aria-label', state.sound ? '音效：开' : '音效：关');
  }

  soundBtn.addEventListener('click', function () {
    state.sound = !state.sound;
    saveState();
    renderSoundBtn();
    if (ensureAudio()) beep(1500, 0, 0.035, 'triangle', 0.12);
  });

  /* ---------- 转动与状态机 ---------- */

  function setSpinning(on) {
    isSpinning = on;
    spinBtn.disabled = on;
    spinBtn.textContent = on ? '转动中...' : '转一下';
    editBtn.disabled = on;
    shareBtn.disabled = on;
    $('tab-add').disabled = on || state.custom.length >= MAX_CUSTOM;
    Array.prototype.forEach.call(tabsEl.children, function (b) { b.disabled = on; });
  }

  function spin() {
    if (isSpinning) return;
    setSpinning(true);
    ensureAudio();

    var wheel = currentWheel();
    var list = wheel.items.slice();
    var n = list.length;
    var targetIndex = Math.floor(Math.random() * n); // 允许连续抽到同一项
    var nextRotation = computeNextRotation(currentRotation, targetIndex, n, Math.random);
    var id = ++spinId;
    var finished = false;

    highlight(-1);
    showIdleResult('转呀转...');
    setMascot('spin');

    function finishSpin() {
      if (finished || id !== spinId) return;
      finished = true;
      pointerEl.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);

      currentRotation = nextRotation;
      var resolved = resolveIndex(nextRotation, n);
      if (resolved !== targetIndex) {
        console.error('转盘结果校验失败', { targetIndex: targetIndex, resolved: resolved, rotation: nextRotation });
      }
      var label = list[targetIndex];
      lastSpin = { targetIndex: targetIndex, resolved: resolved, rotation: nextRotation, label: label };

      resultEl.textContent = resultText(wheel, label);
      void resultEl.offsetWidth; // 重新触发弹入动画
      resultEl.classList.add('show');
      highlight(targetIndex);
      setMascot('happy');
      playChime();
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* 忽略 */ } }

      state.history.unshift({ label: label, cat: wheel.name, t: Date.now() });
      state.history = state.history.slice(0, HISTORY_SIZE);
      saveState();

      setSpinning(false);
      updateDebug();
    }

    function onEnd(e) {
      if (e.target === pointerEl && e.propertyName === 'transform') finishSpin();
    }

    pointerEl.addEventListener('transitionend', onEnd);
    var timer = setTimeout(finishSpin, FALLBACK_MS);

    pointerEl.style.transition = 'transform ' + SPIN_MS + 'ms ' + EASING;
    pointerEl.style.transform = 'rotate(' + nextRotation + 'deg)';
    startTickLoop(id, n);

    lastSpin = { targetIndex: targetIndex, resolved: null, rotation: nextRotation, label: list[targetIndex] };
    updateDebug();
  }

  function updateDebug() {
    if (!DEBUG) return;
    var s = lastSpin;
    var n = options().length;
    debugEl.textContent =
      currentWheel().name + '  N=' + n + '  slice=' + (360 / n).toFixed(2) + '°\n' +
      (s ? 'target=' + s.targetIndex + ' (' + s.label + ')\n' +
           'rotation=' + s.rotation.toFixed(2) + '°  mod=' + (s.rotation % 360).toFixed(2) + '°\n' +
           'resolved=' + (s.resolved === null ? '…' : s.resolved) +
           (s.resolved === null ? '' : (s.resolved === s.targetIndex ? '  ✓' : '  ✗ 不一致'))
         : '尚未转动') +
      '\nspinning=' + isSpinning;
  }

  /* ---------- 编辑 / 新建转盘 ---------- */

  var editSheet = $('edit-sheet'), editList = $('edit-list'), editError = $('edit-error');
  var addForm = $('add-form'), addInput = $('add-input'), addBtn = $('add-btn');
  var nameRow = $('name-row'), nameInput = $('name-input');
  var resetBtn = $('edit-reset'), deleteBtn = $('edit-delete');
  var draft = [];
  var editing = null; // { mode: 'edit' | 'new', id }

  function renderDraft() {
    while (editList.firstChild) editList.removeChild(editList.firstChild);
    draft.forEach(function (value, i) {
      var li = document.createElement('li');
      li.className = 'edit-item';
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = sliceColor(i, draft.length);
      var input = document.createElement('input');
      input.type = 'text';
      input.maxLength = MAX_LEN;
      input.value = value;
      input.setAttribute('aria-label', '第 ' + (i + 1) + ' 项');
      input.addEventListener('input', function () { draft[i] = input.value; editError.textContent = ''; });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del-btn';
      del.textContent = '✕';
      del.setAttribute('aria-label', '删除' + value);
      del.disabled = draft.length <= MIN_ITEMS && editing.mode === 'edit';
      del.addEventListener('click', function () {
        draft.splice(i, 1);
        editError.textContent = '';
        renderDraft();
      });
      li.appendChild(sw);
      li.appendChild(input);
      li.appendChild(del);
      editList.appendChild(li);
    });
    var full = draft.length >= MAX_ITEMS;
    addInput.disabled = full;
    addBtn.disabled = full;
    addInput.placeholder = full ? '已达到 ' + MAX_ITEMS + ' 项上限' : '新增一项，比如：拉面';
  }

  function resetDeleteBtn() {
    deleteBtn.dataset.armed = '';
    deleteBtn.textContent = '删除这个转盘';
  }

  function openSheet(mode, wheel) {
    editing = { mode: mode, id: wheel ? wheel.id : null };
    var isNew = mode === 'new';
    var isBuiltin = !!(wheel && wheel.builtin);
    $('edit-title').textContent = isNew ? '新建转盘' : '编辑「' + wheel.name + '」';
    nameRow.hidden = isBuiltin;
    nameInput.value = isNew ? '' : (isBuiltin ? wheel.name : wheel.name);
    resetBtn.hidden = !isBuiltin;
    deleteBtn.hidden = isNew || isBuiltin;
    resetDeleteBtn();
    draft = isNew ? [] : wheel.items.slice();
    editError.textContent = '';
    addInput.value = '';
    renderDraft();
    editSheet.showModal();
    if (isNew) nameInput.focus();
  }

  function openEdit() { if (!isSpinning) openSheet('edit', currentWheel()); }
  function openCreate() {
    if (isSpinning) return;
    if (state.custom.length >= MAX_CUSTOM) { toast('最多只能建 ' + MAX_CUSTOM + ' 个自定义转盘'); return; }
    openSheet('new', null);
  }

  addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = addInput.value.trim();
    if (!v) { editError.textContent = '先输入要添加的内容'; return; }
    if (draft.length >= MAX_ITEMS) { editError.textContent = '最多 ' + MAX_ITEMS + ' 项'; return; }
    if (draft.some(function (s) { return s.trim() === v; })) { editError.textContent = '「' + v + '」已经有了'; return; }
    draft.push(v);
    addInput.value = '';
    editError.textContent = '';
    renderDraft();
    addInput.focus();
  });

  resetBtn.addEventListener('click', function () {
    var w = getWheel(editing.id);
    if (!w || !w.builtin) return;
    draft = w.defaults.slice();
    editError.textContent = '已恢复默认，点「保存」生效';
    renderDraft();
  });

  // 删除需要连点两次，避免误删
  deleteBtn.addEventListener('click', function () {
    if (deleteBtn.dataset.armed !== '1') {
      deleteBtn.dataset.armed = '1';
      deleteBtn.textContent = '再点一次确认删除';
      return;
    }
    var name = (getWheel(editing.id) || {}).name;
    state.custom = state.custom.filter(function (c) { return c.id !== editing.id; });
    if (state.current === editing.id) state.current = 'main';
    saveState();
    editSheet.close();
    refreshAll();
    toast('已删除「' + name + '」');
  });

  $('edit-cancel').addEventListener('click', function () { editSheet.close(); });

  $('edit-save').addEventListener('click', function () {
    var w = editing.mode === 'edit' ? getWheel(editing.id) : null;
    var needName = !w || !w.builtin;
    var name = nameInput.value.trim();
    if (needName) {
      if (!name) { editError.textContent = '给转盘起个名字吧'; nameInput.focus(); return; }
      if (name.length > MAX_NAME) { editError.textContent = '名字最多 ' + MAX_NAME + ' 个字'; return; }
      var clash = allWheels().some(function (x) { return x.name === name && (!w || x.id !== w.id); });
      if (clash) { editError.textContent = '已经有叫「' + name + '」的转盘了'; return; }
    }
    var problem = findProblem(draft);
    if (problem) { editError.textContent = problem; return; }
    var items = draft.map(function (s) { return s.trim(); });

    if (editing.mode === 'new') {
      var id = newId();
      state.custom.push({ id: id, name: name, items: items });
      state.current = id;
    } else if (w.builtin) {
      state.lists[w.id] = items;
    } else {
      state.custom.forEach(function (c) { if (c.id === w.id) { c.name = name; c.items = items; } });
    }
    saveState();
    editSheet.close();
    refreshAll(editing.mode === 'new' ? '新转盘做好啦，转一下吧' : '选项更新好啦');
  });

  editBtn.addEventListener('click', openEdit);
  $('tab-add').addEventListener('click', openCreate);

  /* ---------- 抽签记录 ---------- */

  var historySheet = $('history-sheet'), historyList = $('history-list'), historyEmpty = $('history-empty');

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function renderHistory() {
    while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
    state.history.forEach(function (h) {
      var d = new Date(h.t);
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = h.label;
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = (h.cat ? h.cat + ' · ' : '') + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      li.appendChild(name);
      li.appendChild(meta);
      historyList.appendChild(li);
    });
    historyEmpty.hidden = state.history.length > 0;
    $('history-clear').hidden = state.history.length === 0;
  }

  historyBtn.addEventListener('click', function () { renderHistory(); historySheet.showModal(); });
  $('history-close').addEventListener('click', function () { historySheet.close(); });
  $('history-clear').addEventListener('click', function () {
    state.history = [];
    saveState();
    renderHistory();
  });

  /* ---------- 分享菜单链接 ----------
   * 把全部转盘编码进网址的 # 部分（不会发到服务器）：
   *   JSON → UTF-8 → base64url
   * 对方打开链接后确认导入，全部转盘替换成链接里的版本。 */

  var shareSheet = $('share-sheet'), shareLink = $('share-link'), shareNative = $('share-native');
  var importSheet = $('import-sheet'), importList = $('import-list');
  var pendingImport = null;

  function toBase64Url(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(code) {
    var b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function encodeMenus() {
    var payload = { v: 1, l: {}, c: [] };
    BUILTINS.forEach(function (b) { payload.l[b.id] = state.lists[b.id]; });
    state.custom.forEach(function (c) { payload.c.push([c.name, c.items]); });
    return toBase64Url(JSON.stringify(payload));
  }

  /** 解析分享码；格式不对返回 null */
  function decodeMenus(code) {
    try {
      if (!code || code.length > 20000) return null;
      var p = JSON.parse(fromBase64Url(code));
      if (!p || p.v !== 1 || typeof p.l !== 'object') return null;
      var custom = (Array.isArray(p.c) ? p.c : []).map(function (x) {
        return Array.isArray(x) ? { name: x[0], items: x[1] } : null;
      });
      return normalizeMenus(p.l, custom);
    } catch (e) {
      return null;
    }
  }

  function shareUrl() {
    return location.origin + location.pathname + SHARE_PREFIX + encodeMenus();
  }

  function openShare() {
    if (isSpinning) return;
    var names = allWheels().map(function (w) { return w.name; });
    $('share-summary').textContent = '包含 ' + names.length + ' 个转盘：' + names.join('、');
    shareLink.value = shareUrl();
    shareNative.hidden = !navigator.share;
    shareSheet.showModal();
  }

  function copyLink() {
    var url = shareLink.value;
    var done = function () { toast('链接已复制，发给朋友吧'); };
    var fallback = function () {
      shareLink.focus();
      shareLink.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('请长按链接手动复制'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback);
    else fallback();
  }

  shareBtn.addEventListener('click', openShare);
  $('share-close').addEventListener('click', function () { shareSheet.close(); });
  $('share-copy').addEventListener('click', copyLink);
  shareNative.addEventListener('click', function () {
    navigator.share({ title: '今天吃什么', text: '我的转盘菜单，点开就能导入：', url: shareLink.value })
      .catch(function () { /* 用户取消分享 */ });
  });

  function clearShareHash() {
    if (location.hash.indexOf(SHARE_PREFIX) === 0) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function checkShareLink() {
    if (location.hash.indexOf(SHARE_PREFIX) !== 0) return;
    var menus = decodeMenus(location.hash.slice(SHARE_PREFIX.length));
    if (!menus) {
      clearShareHash();
      toast('这个分享链接好像不完整，导入不了');
      return;
    }
    pendingImport = menus;
    while (importList.firstChild) importList.removeChild(importList.firstChild);
    var rows = BUILTINS.map(function (b) { return [b.name, menus.lists[b.id]]; })
      .concat(menus.custom.map(function (c) { return [c.name, c.items]; }));
    rows.forEach(function (r) {
      var li = document.createElement('li');
      var b = document.createElement('b');
      b.textContent = r[0];
      li.appendChild(b);
      li.appendChild(document.createTextNode('：' + r[1].join('、')));
      importList.appendChild(li);
    });
    if (!importSheet.open) importSheet.showModal();
  }

  $('import-ok').addEventListener('click', function () {
    if (!pendingImport) return;
    state.lists = pendingImport.lists;
    state.custom = pendingImport.custom;
    if (!getWheel(state.current)) state.current = 'main';
    pendingImport = null;
    saveState();
    clearShareHash();
    importSheet.close();
    refreshAll('菜单导入好啦，转一下吧');
    toast('导入成功');
  });
  $('import-cancel').addEventListener('click', function () {
    pendingImport = null;
    clearShareHash();
    importSheet.close();
  });

  window.addEventListener('hashchange', checkShareLink);

  // 点面板外的遮罩关闭（导入确认除外，必须明确选择）
  [editSheet, historySheet, shareSheet].forEach(function (sheet) {
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });
  });

  /* ---------- PWA ---------- */

  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(function () {
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  });
  window.addEventListener('appinstalled', function () { installBtn.hidden = true; });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service Worker 注册失败', err);
      });
    });
  }

  /* ---------- 启动 ---------- */

  currentWheel();
  refreshAll();
  renderSoundBtn();
  spinBtn.addEventListener('click', spin);
  if (DEBUG) { debugEl.hidden = false; updateDebug(); }
  checkShareLink();

  // 供自动化测试读取
  window.__wheel = {
    getState: function () {
      return {
        options: options().slice(), category: currentWheel().id, wheelName: currentWheel().name,
        custom: JSON.parse(JSON.stringify(state.custom)), currentRotation: currentRotation,
        isSpinning: isSpinning, lastSpin: lastSpin, history: state.history.slice()
      };
    },
    computeNextRotation: computeNextRotation,
    resolveIndex: resolveIndex
  };
})();
