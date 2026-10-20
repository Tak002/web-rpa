// 파일 이름 정리: Windows 에서 저장할 수 있는 이름으로 바꾸고, 같은 이름이 있으면 " (1)" 식으로 번호를 붙인다.

import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_NAME = 150; // 실행 폴더 경로가 길어도 Windows 경로 한도(260자)를 넘지 않게
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Windows 에서 쓸 수 있는 파일 이름으로 바꾼다. 비면 오류. */
export function safeFileName(name, { maxLength = MAX_NAME } = {}) {
  let s = String(name ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // 끝의 점·공백은 Windows 가 지워 버린다
  if (!s || /^[_ .]+$/.test(s)) throw new Error(`쓸 수 없는 파일 이름입니다: "${name ?? ''}"`);
  const dot = s.indexOf('.');
  const stem = dot > 0 ? s.slice(0, dot) : s;
  if (RESERVED.test(stem.trim())) s = `_${s}`;
  if (s.length > maxLength) {
    const ext = path.extname(s);
    const keep = ext.length > 0 && ext.length <= 16 ? ext : '';
    s = `${s.slice(0, maxLength - keep.length).replace(/[. ]+$/, '')}${keep}`;
  }
  return s;
}

/** 이름에 확장자를 맞춘다: 이미 같은 확장자면 그대로, 아니면 붙인다. */
export function withExtension(name, ext) {
  if (!ext) return name;
  return path.extname(name).toLowerCase() === ext.toLowerCase() ? name : `${name}${ext}`;
}

/**
 * dir 안에 겹치지 않는 파일 자리를 잡는다 (빈 파일을 독점 생성해 동시에 같은 이름을 잡지 않게).
 * @returns {Promise<string>} 전체 경로
 */
export async function reserveFile(dir, name) {
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 0; n < 10000; n += 1) {
    const file = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      const fh = await fs.open(file, 'wx');
      await fh.close();
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`저장할 이름을 정하지 못했습니다: ${name}`);
}
