// 출력 저장: PDF (숨김 실행은 인쇄용 PDF, 화면 표시 실행은 전체 화면 캡처를 A4 로 나눈 PDF), 화면 캡처, 다운로드 파일.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { safeFileName, withExtension, reserveFile } from './naming.js';

const A4 = { w: 595.28, h: 841.89 }; // pt
const MAX_PDF_PAGES = 40;

/** 파일 이름 규칙(변수 치환)으로 이름을 정하고 files/ 에 겹치지 않는 자리를 잡는다. */
export async function reserveOutput(rc, template, fallback, ext) {
  let name = template ? rc.scope.resolve(template) : fallback;
  name = safeFileName(ext ? withExtension(name, ext) : name);
  return reserveFile(rc.filesDir, name);
}

/** 저장 결과가 정상 PDF 인지 확인 */
export async function verifyPdf(file) {
  const buf = await fs.readFile(file);
  if (buf.length < 64 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('저장한 파일이 PDF 형식이 아닙니다.');
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  if (doc.getPageCount() < 1) throw new Error('저장한 PDF 에 쪽이 없습니다.');
  return doc.getPageCount();
}

/** 화면 표시 실행: 전체 화면을 A4 비율로 잘라 캡처해 이미지 PDF 로 묶는다. */
async function screenshotPdf(page, file, { landscape = false } = {}) {
  const dims = await page.evaluate(() => {
    const d = document.documentElement;
    const b = document.body;
    return {
      w: Math.max(d.clientWidth, Math.min(d.scrollWidth, 4000)),
      h: Math.max(d.clientHeight, d.scrollHeight, b ? b.scrollHeight : 0),
    };
  });
  const sheet = landscape ? { w: A4.h, h: A4.w } : A4;
  const margin = 18;
  const width = Math.max(200, Math.round(dims.w));
  const sliceH = Math.max(200, Math.round((width * (sheet.h - margin * 2)) / (sheet.w - margin * 2)));
  const total = Math.max(1, Math.round(dims.h));
  const doc = await PDFDocument.create();
  for (let y = 0, n = 0; y < total && n < MAX_PDF_PAGES; y += sliceH, n += 1) {
    const height = Math.min(sliceH, total - y);
    const png = await page.screenshot({ fullPage: true, clip: { x: 0, y, width, height }, timeout: 30000 });
    const img = await doc.embedPng(png);
    const scale = (sheet.w - margin * 2) / img.width;
    const pg = doc.addPage([sheet.w, sheet.h]);
    pg.drawImage(img, { x: margin, y: sheet.h - margin - img.height * scale, width: img.width * scale, height: img.height * scale });
  }
  await fs.writeFile(file, await doc.save());
}

export async function savePdf(rc, step) {
  const page = await rc.sess.livePage();
  const file = await reserveOutput(rc, step.fileName, `${rc.recipe.name || '출력'}_${rc.scope.rowNumber}`, '.pdf');
  try {
    await rc.sleep(Math.min(Math.max(Number(step.settleMs ?? 500) || 0, 0), 30000)); // 화면이 다 그려질 때까지
    if (rc.options.headless) {
      await page.pdf({ path: file, format: step.format || 'A4', landscape: !!step.landscape, printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    } else await screenshotPdf(page, file, { landscape: !!step.landscape });
    const pages = await verifyPdf(file);
    rc.addFile(file);
    return `${path.basename(file)} (${pages}쪽)`;
  } catch (e) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw Object.assign(new Error(`PDF 저장 실패: ${String(e.message).split('\n')[0]}`), { sideEffect: true });
  }
}

export async function saveScreenshot(rc, step) {
  const page = await rc.sess.livePage();
  const template = step.fileName;
  const ext = /\.(png|jpe?g)$/i.test(String(template ?? '')) ? undefined : '.png';
  const file = await reserveOutput(rc, template, `화면_${rc.scope.rowNumber}`, ext);
  try {
    await page.screenshot({ path: file, fullPage: step.fullPage !== false, timeout: 30000 });
  } catch (e) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw new Error(`화면 캡처 실패: ${String(e.message).split('\n')[0]}`);
  }
  rc.addFile(file);
  return path.basename(file);
}

/**
 * 받은 다운로드를 저장한다: 이름은 fileName 규칙(확장자는 원래 것) 또는 사이트가 준 이름. 빈 파일·실패는 오류.
 */
export async function saveDownload(rc, step, download) {
  const failure = await download.failure();
  if (failure) throw Object.assign(new Error(`다운로드 실패: ${failure}`), { sideEffect: true });
  const suggested = download.suggestedFilename() || 'download';
  const ext = path.extname(suggested);
  const file = step.fileName ? await reserveOutput(rc, step.fileName, suggested, ext) : await reserveOutput(rc, null, suggested);
  try {
    await download.saveAs(file);
    const st = await fs.stat(file);
    if (!st.size) throw new Error('빈 파일');
  } catch (e) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw Object.assign(new Error(`다운로드 저장 실패 (${suggested}): ${String(e.message).split('\n')[0]}`), { sideEffect: true });
  }
  rc.addFile(file);
  return path.basename(file);
}
