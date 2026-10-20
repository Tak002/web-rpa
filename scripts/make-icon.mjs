// 화면 로고(public/index.html 의 파비콘과 같은 모양)로 Windows 아이콘 assets/web-rpa.ico 를 만든다.
// 실행: node scripts/make-icon.mjs   (설치된 Edge 로 그린다)

import fs from 'node:fs/promises';
import path from 'node:path';
import { startBrowser } from '../src/browser.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const svg = (s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f5d9e"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>`;

const profileDir = path.join(ROOT, 'dist', 'icon-profile');
const ctx = await startBrowser({ profileDir, headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const pngs = [];
for (const s of SIZES) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(s)}</body></html>`);
  pngs.push(await page.locator('svg').screenshot({ omitBackground: true }));
}
await ctx.close();

// ICO = 머리(6바이트) + 항목(16바이트 × n) + PNG 데이터
const header = Buffer.alloc(6 + 16 * SIZES.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // 아이콘
header.writeUInt16LE(SIZES.length, 4);
let offset = header.length;
SIZES.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s >= 256 ? 0 : s, e); // 256 은 0 으로 적는다
  header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4); // 색 평면
  header.writeUInt16LE(32, e + 6); // 비트 수
  header.writeUInt32LE(pngs[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
const out = path.join(ROOT, 'assets', 'web-rpa.ico');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, Buffer.concat([header, ...pngs]));
await fs.rm(profileDir, { recursive: true, force: true });
console.log(`만들었습니다: ${out} (${SIZES.join(', ')}px)`);
