// 生成 PWA 桌面图标（真实 PNG）。用法：node tools/gen-icons.js
// 图标使用 assets/mascot-main.png（包子小厨师主姿态），放在暖杏色圆润背景上。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mascot = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'assets', 'mascot-main.png')).toString('base64');

function iconHtml(size, scale) {
  // scale：吉祥物高度占画布的比例（maskable 图标四周要留安全区）
  const h = size * scale;
  return `<html><body style="margin:0">
    <div id="icon" style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;
      background: radial-gradient(circle at 50% 45%, #fffaf0 0, #ffe9cc 55%, #ffd3a3 100%);">
      <img src="${mascot}" style="height:${h}px;margin-top:${size * 0.03}px">
    </div></body></html>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jobs = [
    ['icon-192.png', 192, 0.84],
    ['icon-512.png', 512, 0.84],
    ['icon-maskable-512.png', 512, 0.66],
  ];
  for (const [name, size, scale] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(iconHtml(size, scale));
    await page.locator('#icon').screenshot({ path: path.join(root, 'icons', name) });
    console.log('生成', name);
  }
  await browser.close();
})();
