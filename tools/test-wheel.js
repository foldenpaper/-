// 自动校验转盘：node tools/test-wheel.js [网址]
// 默认网址 http://localhost:8000/ ，需先在项目根目录运行：python3 -m http.server 8000
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8000/';
let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) failures++; };

// 读取"指针尖正下方"实际渲染的是哪块扇区（真实画面，不是算法自己算的数）
async function sliceUnderPointer(page) {
  return page.evaluate(() => {
    // 勺子尖端的实际屏幕位置（勺子和吉祥物不拦截点击，所以能取到下面的扇区）
    const tip = document.getElementById('pointer-tip').getBoundingClientRect();
    const el = document.elementFromPoint(tip.left + tip.width / 2, tip.top + tip.height / 2);
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
    await page.goto(BASE + '?spinms=60');
    // 转几次，让指针停在不同角度后再检查（旋转图层不能把页面撑宽）
    for (let i = 0; i < 3; i++) await spinOnce(page);
    const r = await page.evaluate((VPW) => {
      const box = s => document.querySelector(s).getBoundingClientRect();
      const inView = b => b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth;
      return {
        title: inView(box('.title')) && inView(box('.tabs')) && inView(box('.toolbar')) && inView(box('#btn-edit')), wheel: inView(box('.wheel-area')),
        result: inView(box('#result')), button: inView(box('#spin')),
        noScroll: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth && innerWidth === VPW,
        wheelSize: Math.round(box('.wheel-area').width),
      };
    }, vp.width);
    check(r.title && r.wheel && r.result && r.button && r.noScroll,
      `${vp.width}×${vp.height}：标题/工具栏/分类/转盘/结果/按钮均在屏内，无滚动（转盘直径 ${r.wheelSize}px）`);
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

  // ---------- 5. 阶段二功能 ----------
  console.log('\n[5] 分类切换 / 编辑选项 / 记录 / 本地保存');
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(BASE + '?spinms=60');
    const S = () => page.evaluate(() => window.__wheel.getState());

    // 勺子尖端落在转盘扇区上（在吉祥物外、转盘边缘内）
    const tipInside = await page.evaluate(() => {
      const w = document.getElementById('wheel').getBoundingClientRect();
      const t = document.getElementById('pointer-tip').getBoundingClientRect();
      const d = Math.hypot(t.left - (w.left + w.width / 2), t.top - (w.top + w.height / 2)) / (w.width / 2);
      return d > 0.5 && d < 0.95;
    });
    check(tipInside, '勺子尖端落在转盘扇区上');

    // 分类切换
    await page.click('.tab[data-cat="night"]');
    let st = await S();
    check(st.category === 'night' && st.options[0] === '拉面' && (await page.locator('#wheel path').count()) === 6,
      '切换到「宵夜」后转盘换成宵夜菜单');
    let r = await spinOnce(page);
    check(r.visual === r.st.lastSpin.targetIndex && r.text === '今天，吃' + r.st.options[r.visual] + '吧', '宵夜转盘结果一致');

    // 转动中不能切换分类或打开编辑
    await page.click('#spin');
    const lockedUi = await page.evaluate(() =>
      document.querySelector('.tab[data-cat="main"]').disabled && document.getElementById('btn-edit').disabled);
    await page.evaluate(() => document.querySelector('.tab[data-cat="main"]').click());
    st = await S();
    check(lockedUi && st.category === 'night', '转动中分类标签和编辑按钮被锁定');
    await page.waitForFunction(() => !window.__wheel.getState().isSpinning);

    // 编辑：校验
    await page.click('#btn-edit');
    await page.fill('#add-input', '拉面');
    await page.click('#add-btn');
    check((await page.textContent('#edit-error')).includes('已经有了'), '添加重复项被拒绝');
    await page.fill('#edit-list li:nth-child(2) input', '   ');
    await page.click('#edit-save');
    check((await page.textContent('#edit-error')).includes('不能为空'), '清空某项后保存被拒绝');
    await page.fill('#edit-list li:nth-child(2) input', '牛丼');
    // 加到 12 项
    for (let i = 0; i < 6; i++) { await page.fill('#add-input', '新菜' + i); await page.click('#add-btn'); }
    check(await page.locator('#add-btn').isDisabled(), '达到 12 项后不能再添加');
    await page.click('#edit-save');
    st = await S();
    check(st.options.length === 12 && st.options[1] === '牛丼' && (await page.locator('#wheel path').count()) === 12,
      '保存后转盘变为 12 格，改名生效');

    // 12 格连转 30 次
    let bad = 0;
    for (let i = 0; i < 30; i++) {
      r = await spinOnce(page);
      if (r.visual !== r.st.lastSpin.targetIndex || r.text !== '今天，吃' + r.st.options[r.visual] + '吧') bad++;
    }
    check(bad === 0, `12 格转盘连转 30 次全部一致（不一致 ${bad} 次）`);

    // 删到只剩 2 项
    await page.click('#btn-edit');
    while ((await page.locator('#edit-list li').count()) > 2) await page.click('#edit-list li:first-child .del-btn');
    check(await page.locator('#edit-list li:first-child .del-btn').isDisabled(), '只剩 2 项时不能再删除');
    await page.click('#edit-save');
    bad = 0;
    for (let i = 0; i < 20; i++) {
      r = await spinOnce(page);
      if (r.visual !== r.st.lastSpin.targetIndex || r.text !== '今天，吃' + r.st.options[r.visual] + '吧') bad++;
    }
    check(bad === 0, `2 格转盘连转 20 次全部一致（不一致 ${bad} 次）`);

    // 记录最多 5 条，最新在前
    st = await S();
    await page.click('#btn-history');
    const items = await page.locator('#history-list li').count();
    const first = await page.textContent('#history-list li:first-child span');
    check(items === 5 && first === st.lastSpin.label, `记录保留最近 5 条，最新在最上面（${items} 条）`);
    await page.click('#history-close');

    // 刷新后保留
    await page.reload();
    const after = await S();
    check(after.category === 'night' && after.options.length === 2 && after.history.length === 5, '刷新页面后分类、选项、记录都还在');

    // 恢复默认
    await page.click('#btn-edit');
    await page.click('#edit-reset');
    await page.click('#edit-save');
    st = await S();
    check(st.options.join() === '拉面,烤串,炸鸡,麻辣烫,关东煮,炒饭', '「恢复默认」恢复宵夜的 6 项');

    // 其他分类不受影响
    await page.click('.tab[data-cat="main"]');
    st = await S();
    check(st.options.join() === '火锅,烧烤,面食,炒菜,饺子,日料', '其他分类的选项不受影响');

    // 音效开关不报错、可保存
    await page.click('#btn-sound');
    await spinOnce(page);
    await page.reload();
    check((await page.getAttribute('#btn-sound', 'aria-pressed')) === 'true', '音效开关可开启并在刷新后保留');

    // 本地数据损坏时能自动恢复
    await page.evaluate(() => localStorage.setItem('what-to-eat:v1', '{坏数据'));
    await page.reload();
    st = await S();
    check(st.options.length === 6 && st.category === 'main', '本地数据损坏时自动回到默认');

    if (process.env.SHOT_DIR) {
      await page.click('#btn-edit');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.SHOT_DIR}/shot-edit.png` });
    }
    await ctx.close();
  }

  // ---------- 6. 自定义转盘 ----------
  console.log('\n[6] 自定义转盘：新建 / 改名 / 结果文案 / 删除');
  {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(BASE + '?spinms=60');
    const S = () => page.evaluate(() => window.__wheel.getState());

    await page.click('#tab-add');
    check(await page.isVisible('#name-input') && (await page.textContent('#edit-title')) === '新建转盘', '点「＋」打开新建转盘面板');
    await page.click('#edit-save');
    check((await page.textContent('#edit-error')).includes('起个名字'), '没填名字不能保存');
    await page.fill('#name-input', '正餐');
    for (const x of ['公园', '电影院']) { await page.fill('#add-input', x); await page.click('#add-btn'); }
    await page.click('#edit-save');
    check((await page.textContent('#edit-error')).includes('已经有叫'), '名字不能和已有转盘重名');
    await page.fill('#name-input', '周末去哪');
    await page.fill('#add-input', '海边'); await page.click('#add-btn');
    await page.click('#edit-save');
    let st = await S();
    check(st.wheelName === '周末去哪' && st.options.join() === '公园,电影院,海边' &&
      (await page.textContent('.tab[aria-selected="true"]')) === '周末去哪', '新建「周末去哪」并自动切换过去');

    let r = await spinOnce(page);
    check(r.visual === r.st.lastSpin.targetIndex && r.text === '就决定是「' + r.st.options[r.visual] + '」啦',
      '自定义转盘结果一致，文案为「就决定是…啦」');

    // 编辑：改名，内置转盘的「恢复默认」不出现，删除按钮出现
    await page.click('#btn-edit');
    check(await page.isHidden('#edit-reset') && await page.isVisible('#edit-delete') && await page.isVisible('#name-input'),
      '自定义转盘可改名、可删除、没有「恢复默认」');
    await page.fill('#name-input', '出去玩');
    await page.click('#edit-save');
    st = await S();
    check(st.wheelName === '出去玩', '改名生效');

    // 内置转盘编辑时不能改名、不能删除
    await page.click('.tab[data-cat="main"]');
    await page.click('#btn-edit');
    check(await page.isHidden('#name-input') && await page.isHidden('#edit-delete') && await page.isVisible('#edit-reset'),
      '内置转盘不能改名、不能删除');
    await page.click('#edit-cancel');

    // 刷新后还在
    await page.reload();
    check((await page.locator('.tab', { hasText: '出去玩' }).count()) === 1, '刷新后自定义转盘还在');

    // 删除需要点两次
    await page.click('.tab:has-text("出去玩")');
    await page.click('#btn-edit');
    await page.click('#edit-delete');
    check((await page.textContent('#edit-delete')).includes('再点一次'), '删除要再点一次确认');
    await page.click('#edit-delete');
    st = await S();
    check(st.custom.length === 0 && st.category === 'main' && (await page.locator('.tab', { hasText: '出去玩' }).count()) === 0,
      '删除后回到「正餐」');

    // 建很多个转盘时，标签栏可以横向滑动，页面不会被撑宽
    for (let k = 0; k < 6; k++) {
      await page.click('#tab-add');
      await page.fill('#name-input', '转盘' + k);
      for (const x of ['甲', '乙']) { await page.fill('#add-input', x); await page.click('#add-btn'); }
      await page.click('#edit-save');
    }
    const lay = await page.evaluate(() => ({
      pageW: document.documentElement.scrollWidth, vw: innerWidth,
      tabsScroll: document.getElementById('tabs').scrollWidth > document.getElementById('tabs').clientWidth,
      selVisible: (() => { const t = document.querySelector('.tab[aria-selected="true"]').getBoundingClientRect(); return t.left >= 0 && t.right <= innerWidth; })()
    }));
    check(lay.pageW <= lay.vw && lay.tabsScroll && lay.selVisible, '转盘多时标签栏可横向滑动，选中的标签自动滚到可见处');
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/shot-custom.png` });
    await ctx.close();
  }

  // ---------- 7. 分享菜单链接 ----------
  console.log('\n[7] 分享菜单链接：生成 → 另一台手机打开 → 导入');
  {
    const a = await browser.newContext({ ...devices['Pixel 7'] });
    const pa = await a.newPage();
    pa.on('pageerror', e => errors.push(String(e)));
    await pa.goto(BASE + '?spinms=60');
    // A 改一下正餐，并新建一个自定义转盘
    await pa.click('#btn-edit');
    await pa.fill('#edit-list li:nth-child(1) input', '寿喜烧');
    await pa.click('#edit-save');
    await pa.click('#tab-add');
    await pa.fill('#name-input', '奶茶店');
    for (const x of ['喜茶', '一点点', 'Tea🍵']) { await pa.fill('#add-input', x); await pa.click('#add-btn'); }
    await pa.click('#edit-save');
    await pa.click('#btn-share');
    const link = await pa.inputValue('#share-link');
    const summary = await pa.textContent('#share-summary');
    check(link.includes('#m=') && summary.includes('5 个转盘') && summary.includes('奶茶店'), `生成分享链接（长度 ${link.length}）`);
    const aState = await pa.evaluate(() => JSON.parse(localStorage.getItem('what-to-eat:v1')));

    // B：另一台手机，原本是默认菜单
    const b = await browser.newContext({ ...devices['Pixel 7'] });
    const pb = await b.newPage();
    pb.on('pageerror', e => errors.push(String(e)));
    await pb.goto(BASE + '?spinms=60');
    await pb.click('#spin'); await pb.waitForFunction(() => !window.__wheel.getState().isSpinning);
    const histBefore = (await pb.evaluate(() => window.__wheel.getState())).history.length;
    const linkB = link.replace(/^https?:\/\/[^/]+/, new URL(BASE).origin).replace(/\/[^/#]*#/, new URL(BASE).pathname + '?spinms=60#');
    await pb.goto(linkB);
    await pb.waitForSelector('#import-sheet[open]');
    const preview = await pb.textContent('#import-list');
    check(preview.includes('寿喜烧') && preview.includes('奶茶店') && preview.includes('Tea🍵'), '打开链接后弹出导入确认，列出全部转盘（含 emoji）');
    await pb.click('#import-ok');
    const bState = await pb.evaluate(() => JSON.parse(localStorage.getItem('what-to-eat:v1')));
    const same = JSON.stringify(aState.lists) === JSON.stringify(bState.lists) &&
      JSON.stringify(aState.custom.map(c => [c.name, c.items])) === JSON.stringify(bState.custom.map(c => [c.name, c.items]));
    check(same, '导入后两台手机的全部转盘完全一样');
    check(bState.history.length === histBefore, '导入不影响对方的抽签记录');
    check(!(await pb.evaluate(() => location.hash)), '导入后网址里的分享码被清掉（刷新不会重复弹窗）');
    await pb.click('.tab:has-text("奶茶店")');
    const r = await spinOnce(pb);
    check(r.visual === r.st.lastSpin.targetIndex && ['喜茶', '一点点', 'Tea🍵'].includes(r.st.lastSpin.label), '导入的转盘可以正常转');

    // 取消导入
    await pb.goto(new URL(BASE).origin + new URL(BASE).pathname + '#m=' + link.split('#m=')[1]);
    await pb.waitForSelector('#import-sheet[open]');
    await pb.click('#import-cancel');
    check(await pb.isHidden('#import-sheet'), '可以取消导入');

    // 坏链接
    await pb.goto(new URL(BASE).origin + new URL(BASE).pathname + '#m=abc!!!');
    await pb.waitForSelector('#toast:not([hidden])');
    check((await pb.textContent('#toast')).includes('不完整') && await pb.isHidden('#import-sheet'), '链接损坏时提示，不会弄坏现有菜单');
    const bAfter = await pb.evaluate(() => JSON.parse(localStorage.getItem('what-to-eat:v1')));
    check(JSON.stringify(bAfter.custom.map(c => c.name)) === JSON.stringify(['奶茶店']), '坏链接没有改动菜单');

    // 复制按钮
    await a.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
    await pa.click('#share-copy');
    await pa.waitForSelector('#toast:not([hidden])');
    const clip = await pa.evaluate(() => navigator.clipboard.readText());
    check(clip === link, '「复制链接」把链接复制到剪贴板');
    if (process.env.SHOT_DIR) await pa.screenshot({ path: `${process.env.SHOT_DIR}/shot-share.png` });
    await a.close(); await b.close();
  }

  check(errors.length === 0, `页面无报错${errors.length ? '：' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(failures ? `\n共 ${failures} 项未通过` : '\n全部通过 ✅');
  process.exit(failures ? 1 : 0);
})();
