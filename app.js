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

  var CATEGORIES = [
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
  var HISTORY_SIZE = 5;
  var FULL_TURNS = 5;
  var EASING = 'cubic-bezier(0.15, 0.85, 0.25, 1)';
  var STORAGE_KEY = 'what-to-eat:v1';

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
  var soundBtn = $('btn-sound'), editBtn = $('btn-edit'), historyBtn = $('btn-history');

  /* ---------- 状态与本地存储 ---------- */

  function defaultState() {
    var lists = {};
    CATEGORIES.forEach(function (c) { lists[c.id] = c.defaults.slice(); });
    return { category: 'main', lists: lists, history: [], sound: false };
  }

  function isValidList(list) {
    return Array.isArray(list) && list.length >= MIN_ITEMS && list.length <= MAX_ITEMS &&
      list.every(function (s) { return typeof s === 'string' && s.trim() && s.length <= MAX_LEN; });
  }

  function loadState() {
    var st = defaultState();
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        if (CATEGORIES.some(function (c) { return c.id === saved.category; })) st.category = saved.category;
        if (saved.lists) CATEGORIES.forEach(function (c) {
          if (isValidList(saved.lists[c.id])) st.lists[c.id] = saved.lists[c.id].slice();
        });
        if (Array.isArray(saved.history)) st.history = saved.history.filter(function (h) {
          return h && typeof h.label === 'string' && typeof h.t === 'number';
        }).slice(0, HISTORY_SIZE);
        st.sound = saved.sound === true;
      }
    } catch (e) { /* 数据损坏时用默认值 */ }
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

  function category() {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === state.category) return CATEGORIES[i];
    return CATEGORIES[0];
  }
  function options() { return state.lists[state.category]; }

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
      var pos = polar(a0 + slice / 2, R * 0.8);
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
    CATEGORIES.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(c.id === state.category));
      b.dataset.cat = c.id;
      b.textContent = c.name;
      b.disabled = isSpinning;
      b.addEventListener('click', function () { switchCategory(c.id); });
      tabsEl.appendChild(b);
    });
  }

  function setMascot(mood) {
    mascotEl.dataset.mood = mood;
  }

  function showIdleResult(text) {
    resultEl.classList.remove('show');
    resultEl.textContent = text;
  }

  function switchCategory(id) {
    if (isSpinning || id === state.category) return;
    state.category = id;
    saveState();
    renderTabs();
    renderWheel();
    setMascot('idle');
    showIdleResult('今天，吃什么好呢');
    lastSpin = null;
    updateDebug();
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
    Array.prototype.forEach.call(tabsEl.children, function (b) { b.disabled = on; });
  }

  function spin() {
    if (isSpinning) return;
    setSpinning(true);
    ensureAudio();

    var list = options().slice();
    var n = list.length;
    var cat = category();
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

      resultEl.textContent = '今天，吃' + label + '吧';
      void resultEl.offsetWidth; // 重新触发弹入动画
      resultEl.classList.add('show');
      highlight(targetIndex);
      setMascot('happy');
      playChime();
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* 忽略 */ } }

      state.history.unshift({ label: label, cat: cat.name, t: Date.now() });
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
      category().name + '  N=' + n + '  slice=' + (360 / n).toFixed(2) + '°\n' +
      (s ? 'target=' + s.targetIndex + ' (' + s.label + ')\n' +
           'rotation=' + s.rotation.toFixed(2) + '°  mod=' + (s.rotation % 360).toFixed(2) + '°\n' +
           'resolved=' + (s.resolved === null ? '…' : s.resolved) +
           (s.resolved === null ? '' : (s.resolved === s.targetIndex ? '  ✓' : '  ✗ 不一致'))
         : '尚未转动') +
      '\nspinning=' + isSpinning;
  }

  /* ---------- 编辑选项 ---------- */

  var editSheet = $('edit-sheet'), editList = $('edit-list'), editError = $('edit-error');
  var addForm = $('add-form'), addInput = $('add-input'), addBtn = $('add-btn');
  var draft = [];

  function findProblem(list) {
    if (list.length < MIN_ITEMS) return '至少需要 ' + MIN_ITEMS + ' 项';
    if (list.length > MAX_ITEMS) return '最多 ' + MAX_ITEMS + ' 项';
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var s = list[i].trim();
      if (!s) return '第 ' + (i + 1) + ' 项不能为空';
      if (s.length > MAX_LEN) return '「' + s + '」太长了，最多 ' + MAX_LEN + ' 个字';
      if (seen[s]) return '「' + s + '」重复了';
      seen[s] = true;
    }
    return null;
  }

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
      del.disabled = draft.length <= MIN_ITEMS;
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

  function openEdit() {
    if (isSpinning) return;
    draft = options().slice();
    $('edit-cat').textContent = category().name;
    editError.textContent = '';
    addInput.value = '';
    renderDraft();
    editSheet.showModal();
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
  });

  $('edit-reset').addEventListener('click', function () {
    draft = category().defaults.slice();
    editError.textContent = '已恢复默认，点「保存」生效';
    renderDraft();
  });

  $('edit-cancel').addEventListener('click', function () { editSheet.close(); });

  $('edit-save').addEventListener('click', function () {
    var problem = findProblem(draft);
    if (problem) { editError.textContent = problem; return; }
    state.lists[state.category] = draft.map(function (s) { return s.trim(); });
    saveState();
    renderWheel();
    lastSpin = null;
    showIdleResult('选项更新好啦');
    setMascot('idle');
    updateDebug();
    editSheet.close();
  });

  editBtn.addEventListener('click', openEdit);

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

  // 点面板外的遮罩关闭
  [editSheet, historySheet].forEach(function (sheet) {
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

  renderTabs();
  renderWheel();
  renderSoundBtn();
  setMascot('idle');
  spinBtn.addEventListener('click', spin);
  if (DEBUG) { debugEl.hidden = false; updateDebug(); }

  // 供自动化测试读取
  window.__wheel = {
    getState: function () {
      return {
        options: options().slice(), category: state.category, currentRotation: currentRotation,
        isSpinning: isSpinning, lastSpin: lastSpin, history: state.history.slice()
      };
    },
    computeNextRotation: computeNextRotation,
    resolveIndex: resolveIndex
  };
})();
