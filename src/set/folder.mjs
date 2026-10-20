// 풀어 둔 세트 폴더 ↔ 파일 목록. 의존성 없음 — 허브 저장소 CI 도 같은 방식으로 묶을 수 있게 따로 둔다.
//   묶기: 폴더 안 파일을 이름(경로) 순서로 zip.mjs 의 writeZip 에 넘긴다 → 같은 내용이면 항상 같은 바이트(같은 sha256).
//   점(.)으로 시작하는 파일·폴더(.git 등)와 Windows 탐색기가 만드는 Thumbs.db·desktop.ini 는 넣지 않는다. 바이트는 바꾸지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { writeZip, readZip } from './zip.mjs';

const SKIP = /^(\..*|Thumbs\.db|desktop\.ini)$/i;

/** 폴더 → Map(세트 안 경로 → Buffer) */
export function readSetDir(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (SKIP.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.set(r, fs.readFileSync(path.join(d, e.name))); // 심볼릭 링크 등은 넣지 않는다
    }
  };
  walk(dir, '');
  return out;
}

/** 파일 목록 → .wrset 바이트 */
export const packFiles = (files) => writeZip([...files].map(([name, data]) => ({ name, data })));

/** 폴더 → .wrset 바이트 */
export const packSetDir = (dir) => packFiles(readSetDir(dir));

/** .wrset 바이트 → 폴더 (경로 탈출은 readZip 이 막는다) */
export function unpackSet(buf, dir) {
  const files = readZip(buf);
  for (const [name, data] of files) {
    const full = path.resolve(dir, name);
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`허용하지 않는 경로: ${name}`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
  return [...files.keys()];
}
