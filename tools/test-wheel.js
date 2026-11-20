// 自动校验转盘：node tools/test-wheel.js [网址]
// 默认网址 http://localhost:8000/ ，需先在项目根目录运行：python3 -m http.server 8000
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8000/';
let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) failures++; };

// 读取"指针尖正下方"实际渲染的是哪块扇区（真实画面，不是算法自己算的数）
async function sliceUnderPointer(page) {
  return page.evaluate(() => {
    const area = document.querySelector('.wheel-area').getBoundingClientRect();
    const x = area.left + area.width / 2;
    const y = area.top + 34; // 指针尖在 top+24 处，再往下一点
    const el = document.elementFromPoint(x, y);
    return el && el.dataset ? Number(el.dataset.index) : -1;
  });
}

async function spinOnce(page) {
  await page.click('#spin');
  await page.waitForFunction(() => !window.__wheel.getState().isSpinning);
  const st = await page.evaluate(() => window.__wheel.getState());
  const text = await page.textContent('#result');
  const visual = await sliceUnderPointer(page);
  return { st, text, visual };
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ---------- 1. 快速连转 100 次 ----------
  console.log('\n[1] 连转 100 次（加速动画），校验 指针所指扇区 = 算法结果 = 显示文字');
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(BASE + '?spinms=60');
    let bad = 0, repeats = 0, prev = -1;
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 100; i++) {
      const { st, text, visual } = await spinOnce(page);
      const s = st.lastSpin;
      const ok = s.resolved === s.targetIndex && visual === s.targetIndex &&
                 text === '今天，吃' + st.options[s.targetIndex] + '吧';
      if (!ok) { bad++; console.log('    第', i + 1, '次不一致', { s, text, visual }); }
      if (s.targetIndex === prev) repeats++;
      prev = s.targetIndex;
      counts[s.targetIndex]++;
    }
    check(bad === 0, `100 次全部一致（不一致 ${bad} 次）`);
    check(repeats > 0, `允许连续抽到同一项（本轮连续重复 ${repeats} 次）`);
    console.log('    各项命中次数：', counts.join(' / '));
    await ctx.close();
  }

  // ---------- 2. 正常速度 10 次 + 转动中连点 ----------
  console.log('\n[2] 正常 2 秒动画转 10 次，每次转动中连点 15 下');
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(BASE);
    let bad = 0, lockBad = 0;
    for (let i = 0; i < 10; i++) {
      const before = await page.evaluate(() => window.__wheel.getState().currentRotation);
      const t0 = Date.now();
      await page.click('#spin');
      for (let k = 0; k < 15; k++) {
        // 即使按钮被禁用，也直接派发点击事件，模拟极端连点
        await page.evaluate(() => document.getElementById('spin').click());
        const midText = await page.textContent('#result');
        const midState = await page.evaluate(() => window.__wheel.getState());
        if (midState.isSpinning && midText.startsWith('今天，吃')) lockBad++;
        await page.waitForTimeout(80);
      }
      const label = await page.textContent('#spin');
      await page.waitForFunction(() => !window.__wheel.getState().isSpinning);
      const elapsed = Date.now() - t0;
      const st = await page.evaluate(() => window.__wheel.getState());
      const text = await page.textContent('#result');
      const visual = await sliceUnderPointer(page);
      const turns = (st.currentRotation - before) / 360;
      const ok = visual === st.lastSpin.targetIndex && text === '今天，吃' + st.options[visual] + '吧' &&
                 turns >= 5 && turns < 6 && elapsed >= 1900 && elapsed < 2900 && label === '转动中...';
      if (!ok) { bad++; console.log('    第', i + 1, '次异常', { visual, text, turns, elapsed, label }); }
      if (i === 0) console.log(`    示例：耗时 ${elapsed}ms，转了 ${turns.toFixed(2)} 圈，转动中按钮文案「${label}」，结果「${text}」`);
    }
    check(bad === 0, '10 次正常速度全部一致，每次只转一轮（5~6 圈）、约 2 秒');
    check(lockBad === 0, '转动期间连点不会提前出结果或重复触发');
    await ctx.close();
  }

  // ---------- 3. 安卓常见屏幕尺寸 ----------
  console.log('\n[3] 安卓常见屏幕尺寸下一屏完整显示、不需滚动');
  for (const vp of [{ width: 360, height: 640 }, { width: 360, height: 740 }, { width: 412, height: 915 }]) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: vp });
    const page = await ctx.newPage();
    await page.goto(BASE);
    const r = await page.evaluate(() => {
      const box = s => document.querySelector(s).getBoundingClientRect();
      const inView = b => b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth;
      return {
        title: inView(box('.title')), wheel: inView(box('.wheel-area')),
        result: inView(box('#result')), button: inView(box('#spin')),
        noScroll: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
        wheelSize: Math.round(box('.wheel-area').width),
      };
    });
    check(r.title && r.wheel && r.result && r.button && r.noScroll,
      `${vp.width}×${vp.height}：标题/转盘/结果/按钮均在屏内，无滚动（转盘直径 ${r.wheelSize}px）`);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/shot-${vp.width}x${vp.height}.png` });
    await ctx.close();
  }

  // ---------- 4. 角度算法穷举 ----------
  console.log('\n[4] 角度算法穷举（2~12 项 × 每一项 × 随机起点）');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE);
    const bad = await page.evaluate(() => {
      const w = window.__wheel; let bad = 0;
      for (let n = 2; n <= 12; n++) for (let t = 0; t < n; t++) for (let k = 0; k < 500; k++) {
        const cur = Math.random() * 1e5;
        const next = w.computeNextRotation(cur, t, n, Math.random);
        const d = next - cur;
        if (w.resolveIndex(next, n) !== t || d < 1800 || d >= 2160) bad++;
      }
      return bad;
    });
    check(bad === 0, `约 3.9 万次组合全部命中目标且只正向转 5~6 圈（失败 ${bad} 次）`);
    await ctx.close();
  }

  check(errors.length === 0, `页面无报错${errors.length ? '：' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(failures ? `\n共 ${failures} 项未通过` : '\n全部通过 ✅');
  process.exit(failures ? 1 : 0);
})();
