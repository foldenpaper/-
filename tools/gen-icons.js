// 生成 PWA 图标（真实 PNG）。用法：node tools/gen-icons.js
// 依赖 Playwright 自带的 Chromium，把一段 SVG 截图成 PNG。
const { chromium } = require('playwright');
const path = require('path');

const COLORS = ['#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#bdb2ff', '#ffc6ff'];

function wheelSvg(size, scale) {
  // scale：转盘占画布的比例（maskable 图标需要留足安全区）
  const c = size / 2;
  const r = (size / 2) * scale;
  let slices = '';
  for (let i = 0; i < 6; i++) {
    const a0 = (i * 60) * Math.PI / 180, a1 = ((i + 1) * 60) * Math.PI / 180;
    const x0 = c + r * Math.sin(a0), y0 = c - r * Math.cos(a0);
    const x1 = c + r * Math.sin(a1), y1 = c - r * Math.cos(a1);
    slices += `<path d="M${c} ${c} L${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1} Z" fill="${COLORS[i]}" stroke="#fff" stroke-width="${size * 0.008}"/>`;
  }
  const ring = r * 1.08;
  const pw = r * 0.22, ph = r * 0.36;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="#ff7a45"/>
    <circle cx="${c}" cy="${c}" r="${ring}" fill="#ffb46b" stroke="#fff" stroke-width="${size * 0.012}"/>
    ${slices}
    <circle cx="${c}" cy="${c}" r="${r * 0.2}" fill="#fff" stroke="#ffb46b" stroke-width="${size * 0.015}"/>
    <path d="M${c - pw} ${c - ring - ph * 0.15} L${c + pw} ${c - ring - ph * 0.15} L${c} ${c - ring + ph * 0.85} Z" fill="#e8402b" stroke="#fff" stroke-width="${size * 0.008}"/>
  </svg>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const jobs = [
    ['icon-192.png', 192, 0.62],
    ['icon-512.png', 512, 0.62],
    ['icon-maskable-512.png', 512, 0.5],
  ];
  for (const [name, size, scale] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0">${wheelSvg(size, scale)}</body></html>`);
    await page.locator('svg').screenshot({ path: path.join(__dirname, '..', 'icons', name), omitBackground: false });
    console.log('生成', name);
  }
  await browser.close();
})();
