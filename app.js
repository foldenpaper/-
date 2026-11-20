/* 今天吃什么 —— 转盘核心逻辑
 *
 * 角度约定（全文件统一）：
 *   - 12 点钟方向为 0°，角度沿顺时针增加。
 *   - 扇区 i（0 ~ N-1）占据 [i * slice, (i + 1) * slice)，slice = 360 / N。
 *   - 极坐标转 SVG 坐标：x = cx + r·sinθ，y = cy − r·cosθ（SVG 的 y 轴向下）。
 *   - 转盘用 CSS rotate(R) 顺时针转动 R 度；指针固定在 0°。
 *     此时指针对着的是转盘自身坐标中的角度 (360 − R mod 360) mod 360。
 */
(function () {
  'use strict';

  var DEFAULT_OPTIONS = ['火锅', '烧烤', '面食', '炒菜', '饺子', '日料'];
  var COLORS = ['#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#bdb2ff', '#ffc6ff',
                '#ffadad', '#a0c4ff', '#d0f4de', '#fcf6bd', '#e4c1f9', '#ffe5d9'];
  var FULL_TURNS = 5;
  var EASING = 'cubic-bezier(0.15, 0.85, 0.25, 1)';

  var params = new URLSearchParams(location.search);
  var DEBUG = params.get('debug') === '1';
  var reducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // ?spinms=xx 仅用于自动化测试加速
  var SPIN_MS = Number(params.get('spinms')) || (reducedMotion ? 800 : 2000);
  var FALLBACK_MS = SPIN_MS + 500;

  var CX = 100, CY = 100, R = 100;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var wheelEl = document.getElementById('wheel');
  var spinBtn = document.getElementById('spin');
  var resultEl = document.getElementById('result');
  var debugEl = document.getElementById('debug');
  var installBtn = document.getElementById('install');

  var options = DEFAULT_OPTIONS.slice();
  var currentRotation = 0;
  var isSpinning = false;
  var spinId = 0;
  var lastSpin = null;

  /* ---------- 纯函数：角度算法 ---------- */

  function polar(angleDeg, radius) {
    var a = angleDeg * Math.PI / 180;
    return { x: CX + radius * Math.sin(a), y: CY - radius * Math.cos(a) };
  }

  /** 让 targetIndex 停在指针下所需的新累计角度 */
  function computeNextRotation(current, targetIndex, n, rand) {
    var slice = 360 / n;
    var offset = (0.2 + rand() * 0.6) * slice; // 避开分界线
    var targetMod = (360 - (targetIndex * slice + offset)) % 360;
    var delta = ((targetMod - (current % 360)) + 360) % 360;
    return current + 360 * FULL_TURNS + delta;
  }

  /** 由转盘累计角度反算指针指向的扇区 */
  function resolveIndex(rotation, n) {
    var slice = 360 / n;
    var pointed = ((360 - (rotation % 360)) % 360 + 360) % 360;
    return Math.floor(pointed / slice) % n;
  }

  /* ---------- 绘制 ---------- */

  function fontSizeFor(n, label) {
    var base = n <= 6 ? 15 : n <= 8 ? 13 : 11;
    if (label.length > 4) base -= 2;
    return base;
  }

  function renderWheel() {
    var n = options.length;
    var slice = 360 / n;
    while (wheelEl.firstChild) wheelEl.removeChild(wheelEl.firstChild);

    for (var i = 0; i < n; i++) {
      var a0 = i * slice;
      var a1 = (i + 1) * slice;
      var p0 = polar(a0, R);
      var p1 = polar(a1, R);
      var largeArc = slice > 180 ? 1 : 0;

      var path = document.createElementNS(SVG_NS, 'path');
      // sweep-flag = 1：在 SVG 屏幕坐标中沿顺时针画弧
      path.setAttribute('d',
        'M ' + CX + ' ' + CY +
        ' L ' + p0.x.toFixed(3) + ' ' + p0.y.toFixed(3) +
        ' A ' + R + ' ' + R + ' 0 ' + largeArc + ' 1 ' + p1.x.toFixed(3) + ' ' + p1.y.toFixed(3) +
        ' Z');
      path.setAttribute('fill', COLORS[i % COLORS.length]);
      path.setAttribute('stroke', '#fff');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('data-index', String(i));
      wheelEl.appendChild(path);

      // 文字先放在 12 点方向，再绕圆心转到扇区中线，扇区转到顶部时文字正好是正的
      var label = options[i];
      var text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', String(CX));
      text.setAttribute('y', String(CY - R * 0.66));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('font-size', String(fontSizeFor(n, label)));
      text.setAttribute('transform', 'rotate(' + (a0 + slice / 2) + ' ' + CX + ' ' + CY + ')');
      text.textContent = label.length > 6 ? label.slice(0, 5) + '…' : label;
      wheelEl.appendChild(text);
    }
  }

  /* ---------- 转动与状态机 ---------- */

  function setSpinning(on) {
    isSpinning = on;
    spinBtn.disabled = on;
    spinBtn.textContent = on ? '转动中...' : '转一下';
  }

  function spin() {
    if (isSpinning) return;
    setSpinning(true);

    var n = options.length;
    var targetIndex = Math.floor(Math.random() * n); // 允许连续抽到同一项
    var nextRotation = computeNextRotation(currentRotation, targetIndex, n, Math.random);
    var id = ++spinId;
    var finished = false;

    resultEl.classList.remove('show');
    resultEl.textContent = '转呀转...';

    function finishSpin() {
      if (finished || id !== spinId) return;
      finished = true;
      wheelEl.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);

      currentRotation = nextRotation;
      var resolved = resolveIndex(nextRotation, n);
      if (resolved !== targetIndex) {
        console.error('转盘结果校验失败', { targetIndex: targetIndex, resolved: resolved, rotation: nextRotation });
      }
      lastSpin = { targetIndex: targetIndex, resolved: resolved, rotation: nextRotation, label: options[targetIndex] };

      resultEl.textContent = '今天，吃' + options[targetIndex] + '吧';
      void resultEl.offsetWidth; // 重新触发弹入动画
      resultEl.classList.add('show');
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* 忽略 */ } }

      setSpinning(false);
      updateDebug();
    }

    function onEnd(e) {
      if (e.target === wheelEl && e.propertyName === 'transform') finishSpin();
    }

    wheelEl.addEventListener('transitionend', onEnd);
    var timer = setTimeout(finishSpin, FALLBACK_MS);

    wheelEl.style.transition = 'transform ' + SPIN_MS + 'ms ' + EASING;
    wheelEl.style.transform = 'rotate(' + nextRotation + 'deg)';

    lastSpin = { targetIndex: targetIndex, resolved: null, rotation: nextRotation, label: options[targetIndex] };
    updateDebug();
  }

  function updateDebug() {
    if (!DEBUG) return;
    var s = lastSpin;
    var n = options.length;
    debugEl.textContent =
      'N=' + n + '  slice=' + (360 / n).toFixed(2) + '°\n' +
      (s ? 'target=' + s.targetIndex + ' (' + s.label + ')\n' +
           'rotation=' + s.rotation.toFixed(2) + '°  mod=' + (s.rotation % 360).toFixed(2) + '°\n' +
           'resolved=' + (s.resolved === null ? '…' : s.resolved) +
           (s.resolved === null ? '' : (s.resolved === s.targetIndex ? '  ✓' : '  ✗ 不一致'))
         : '尚未转动') +
      '\nspinning=' + isSpinning;
  }

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

  renderWheel();
  spinBtn.addEventListener('click', spin);
  if (DEBUG) { debugEl.hidden = false; updateDebug(); }

  // 供自动化测试读取
  window.__wheel = {
    getState: function () {
      return { options: options.slice(), currentRotation: currentRotation, isSpinning: isSpinning, lastSpin: lastSpin };
    },
    computeNextRotation: computeNextRotation,
    resolveIndex: resolveIndex
  };
})();
