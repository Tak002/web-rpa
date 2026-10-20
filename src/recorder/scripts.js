// 페이지에 넣는 스크립트 원문 (dom.page.js · capture.page.js) 과 실행용 작은 스크립트.

import fs from 'node:fs';

const read = (name) =>
  fs
    .readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
    .trim()
    .replace(/;+\s*$/, '');

/** 요소 도구 (window.__webRpa) */
export const DOM_SCRIPT = read('dom.page.js');
/** 녹화 캡처 */
export const CAPTURE_SCRIPT = read('capture.page.js');
/** 재생용: 사이트의 window.print() 를 막는다 (인쇄창이 페이지를 멈추게 하므로 출력은 pdf 스텝이 맡는다). */
export const PLAY_SCRIPT = `(() => {
  if (window.__webRpaNoPrint) return true;
  Object.defineProperty(window, '__webRpaNoPrint', { value: true });
  window.print = function () { window.__webRpaPrinted = (window.__webRpaPrinted || 0) + 1; };
  return true;
})()`;

/** 문서 시작 때 넣을 스크립트 (addInitScript) */
export const asInitScript = (...parts) => parts.map((p) => `${p};`).join('\n');
/** 이미 열린 문서에 넣고 마지막 스크립트의 값을 돌려받는 식 (frame.evaluate) */
export const asExpression = (...parts) => `(${parts.join(',\n')})`;
