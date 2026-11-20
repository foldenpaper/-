// 生成 PWA 桌面图标（真实 PNG）。用法：node tools/gen-icons.js
// 图标直接取自 index.html 里的小包子吉祥物 SVG，改了吉祥物后重新运行即可。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const m = html.match(/<div id="mascot"[^>]*>\s*(<svg[\s\S]*?<\/svg>)/);
if (!m) throw new Error('index.html 里没找到吉祥物 SVG');
// 图标用开心的表情
const mascot = m[1]
  .replace(/<g class="face face-(idle|spin)"[\s\S]*?<\/g>\s*/g, '')
  .replace('class="face face-happy"', '');

function iconHtml(size, scale) {
  // scale：吉祥物占画布的比例（maskable 图标四周要留安全区）
  const s = size * scale;
  return `<html><body style="margin:0">
    <div id="icon" style="width:${size}px;height:${size}px;position:relative;
      background: radial-gradient(circle at 50% 42%, #fff6e6 0, #ffe2bf 55%, #ffcf9c 100%);">
      <div style="position:absolute;width:${s}px;height:${s}px;left:${(size - s) / 2}px;top:${(size - s) / 2 + size * 0.02}px">
        ${mascot.replace('<svg', '<svg width="100%" height="100%"')}
      </div>
    </div></body></html>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jobs = [
    ['icon-192.png', 192, 0.86],
    ['icon-512.png', 512, 0.86],
    ['icon-maskable-512.png', 512, 0.68],
  ];
  for (const [name, size, scale] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(iconHtml(size, scale));
    await page.locator('#icon').screenshot({ path: path.join(root, 'icons', name) });
    console.log('生成', name);
  }
  await browser.close();
})();
