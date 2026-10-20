// RPA 실험실: 로그인(세션 쿠키) · 다운로드 9종 · 팝업 검색창 · 파일 첨부 2종 · 대화상자 3종 · 중첩 iframe · shadow DOM · 월별 고지서 목록.
// 서버가 받은 요청(저장·내보내기·다운로드)을 이벤트로 남겨, 실행기가 실제로 무엇을 몇 번 했는지 시험에서 확인한다.
// 단독 실행: node test/lab-server.mjs 4811

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const LAB = path.join(import.meta.dirname, 'lab');
export const LAB_USER = { id: 'tester', pw: 'lab-pass-123' };
export const PARTNERS = [
  ['P001', '가나상사'],
  ['P002', '다라상사'],
  ['P003', '마바상사'],
  ['P004', '사아상사'],
];
export const MANUAL_TEXT = 'RPA 실험실 사용 설명서\r\n이 파일은 매 행 같은 내용입니다.\r\n';
export const BIG_SIZE = 3 * 1024 * 1024;
const NHIS_YEAR = 2026;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 원장 조회 결과 (화면 JS 와 같은 규칙). */
export function ledgerRows(biz, period) {
  const seed = [...String(biz)].reduce((s, d) => s + Number(d), 0);
  return [1, 2, 3].map((i) => ({
    date: `2026-${String(period === 'H1' ? i : i + 6).padStart(2, '0')}-15`,
    partner: PARTNERS[i - 1][1],
    amount: (seed + i) * 1000,
  }));
}

/** 사업자번호마다 다른, 재현 가능한 3MB 바이너리. */
export function bigFile(biz) {
  const buf = Buffer.alloc(BIG_SIZE);
  let x = Number(String(biz).slice(-6)) || 1;
  for (let i = 0; i < BIG_SIZE; i += 4) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    buf.writeUInt32LE(x, i);
  }
  return buf;
}

export const ymLabel = (m) => `${NHIS_YEAR}년 ${String(m).padStart(2, '0')}월`;
export const nhisAmount = (m) => 180000 + m * 1370;

async function makePdf(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  lines.forEach((t, i) => page.drawText(t, { x: 60, y: 780 - i * 24, size: 14, font }));
  return Buffer.from(await doc.save());
}

const attachment = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export function startLab(port = 0) {
  const sessions = new Set();
  const jobs = new Map();
  const state = { events: [], receipt: 0, nhisUpto: 7, nhisOrder: 'desc' };
  const log = (type, data = {}) => state.events.push({ t: Date.now(), type, ...data });

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e.stack || e));
    }
  });

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }
  const json = (res, obj, status = 200) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  const sendFile = (res, name, type, buf) =>
    res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'content-disposition': attachment(name), 'cache-control': 'no-store' }).end(buf);
  const cookieSid = (req) => /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://lab');
    const p = url.pathname;
    const biz = url.searchParams.get('biz') ?? '';

    // ---------- 시험 제어용 (인증 없음) ----------
    if (p === '/api/events') return json(res, { events: state.events, nhisUpto: state.nhisUpto, nhisOrder: state.nhisOrder });
    if (p === '/api/admin/reset' && req.method === 'POST') {
      state.events = [];
      state.receipt = 0;
      state.nhisUpto = 7;
      state.nhisOrder = 'desc';
      return json(res, { ok: true });
    }
    if (p === '/api/admin/state' && req.method === 'POST') {
      const b = JSON.parse((await body(req)).toString('utf8') || '{}');
      if (b.nhisUpto) state.nhisUpto = Number(b.nhisUpto);
      if (b.nhisOrder) state.nhisOrder = b.nhisOrder;
      log('admin', b);
      return json(res, { ok: true, nhisUpto: state.nhisUpto, nhisOrder: state.nhisOrder });
    }
    if (p === '/lab.css') return res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }).end(await fs.readFile(path.join(LAB, 'lab.css')));

    // ---------- 로그인 ----------
    if (p === '/' ) return res.writeHead(302, { location: '/ledger.html' }).end();
    if (p === '/login' && req.method === 'POST') {
      const f = new URLSearchParams((await body(req)).toString('utf8'));
      const next = f.get('next') || '/ledger.html';
      if (f.get('uid') === LAB_USER.id && f.get('upw') === LAB_USER.pw) {
        const sid = crypto.randomBytes(12).toString('hex');
        sessions.add(sid);
        log('login', { ok: true });
        // 만료 없는 세션 쿠키: 브라우저를 닫으면 사라진다 (실제 사이트 대부분과 같다)
        return res.writeHead(302, { location: next, 'set-cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` }).end();
      }
      log('login', { ok: false });
      return res.writeHead(302, { location: `/login.html?error=1&next=${encodeURIComponent(next)}` }).end();
    }
    if (p === '/logout') {
      sessions.delete(cookieSid(req));
      return res.writeHead(302, { location: '/login.html', 'set-cookie': 'sid=; Path=/; Max-Age=0' }).end();
    }
    const authed = sessions.has(cookieSid(req));
    if (p === '/login.html') {
      if (authed) return res.writeHead(302, { location: url.searchParams.get('next') || '/ledger.html' }).end();
      return page(res, 'login.html');
    }
    if (!authed) {
      if (p.endsWith('.html')) return res.writeHead(302, { location: `/login.html?next=${encodeURIComponent(p + url.search)}` }).end();
      return json(res, { error: '로그인이 필요합니다' }, 401);
    }

    // ---------- 다운로드 ----------
    if (p === '/files/manual.txt') {
      log('download', { kind: 'manual' });
      return sendFile(res, '사용설명서.txt', 'text/plain; charset=utf-8', Buffer.from(MANUAL_TEXT));
    }
    if (p === '/export' && req.method === 'POST') {
      const f = new URLSearchParams((await body(req)).toString('utf8'));
      const b = f.get('biz');
      const period = f.get('period');
      log('export', { biz: b, period });
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('매출장');
      ws.addRow(['사업자번호', '기간', '일자', '거래처', '금액']);
      for (const r of ledgerRows(b, period)) ws.addRow([b, period, r.date, r.partner, r.amount]);
      return sendFile(res, `매출장_${b}_${period}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from(await wb.xlsx.writeBuffer()));
    }
    if (p === '/cert.pdf') {
      log('cert', { biz });
      return sendFile(res, `납세증명서_${biz}.pdf`, 'application/pdf', await makePdf(['RPA LAB - Tax certificate', `biz: ${biz}`]));
    }
    if (p === '/api/job' && req.method === 'POST') {
      const id = crypto.randomBytes(4).toString('hex');
      jobs.set(id, { biz, readyAt: Date.now() + 3500 });
      log('job', { biz, id });
      return json(res, { id });
    }
    let m = /^\/api\/job\/(\w+)$/.exec(p);
    if (m) return json(res, { ready: (jobs.get(m[1])?.readyAt ?? Infinity) <= Date.now() });
    m = /^\/job\/(\w+)\/file$/.exec(p);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return json(res, { error: 'no job' }, 404);
      log('download', { kind: 'big', biz: job.biz });
      return sendFile(res, `대용량_${job.biz}.bin`, 'application/octet-stream', bigFile(job.biz));
    }
    if (p === '/files/popup.csv') {
      await new Promise((r) => setTimeout(r, 500));
      log('download', { kind: 'popup', biz });
      return sendFile(res, `popup_${biz}.csv`, 'text/csv; charset=utf-8', Buffer.from(`﻿구분,사업자번호\r\n새 창,${biz}\r\n`));
    }
    if (p === '/files/frame.txt') {
      log('download', { kind: 'frame', biz });
      return sendFile(res, `frame_${biz}.txt`, 'text/plain; charset=utf-8', Buffer.from(`iframe 안에서 받은 파일 ${biz}`));
    }
    if (p === '/files/blank.txt') {
      log('download', { kind: 'blank', biz });
      return sendFile(res, `blank_${biz}.txt`, 'text/plain; charset=utf-8', Buffer.from(`새 탭 링크로 받은 파일 ${biz}`));
    }

    // ---------- 저장 (multipart) ----------
    if (p === '/api/save' && req.method === 'POST') {
      const fd = await new Response(await body(req), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const fields = {};
      const files = [];
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else if (v.size) files.push({ field: k, name: v.name, size: v.size, sha: sha256(Buffer.from(await v.arrayBuffer())) });
      }
      const receipt = `R-${String((state.receipt += 1)).padStart(4, '0')}`;
      const review = Number(String(fields.biz).slice(-1)) % 2 === 1; // 끝자리가 홀수면 검토 필요
      log('save', { receipt, review, fields, files });
      return json(res, { receipt, review });
    }
    if (p === '/api/review' && req.method === 'POST') {
      log('review', { receipt: url.searchParams.get('receipt') });
      return json(res, { ok: true });
    }

    // ---------- 건강보험 고지 (월별 목록) ----------
    if (p === '/api/nhis/list') {
      const months = [];
      for (let mo = 5; mo <= state.nhisUpto; mo += 1) months.push({ ym: ymLabel(mo), key: `${NHIS_YEAR}${String(mo).padStart(2, '0')}`, amount: nhisAmount(mo), paid: mo < state.nhisUpto });
      if (state.nhisOrder === 'desc') months.reverse();
      return json(res, { months });
    }
    if (p === '/nhis/bill') {
      const ym = url.searchParams.get('ym') ?? '';
      log('nhisBill', { ym });
      return sendFile(res, `건강보험_고지서_${ym}.pdf`, 'application/pdf', await makePdf(['RPA LAB - NHIS bill', `month: ${ym.replace(/\D/g, '')}`]));
    }

    if (p.endsWith('.html')) return page(res, path.basename(p));
    res.writeHead(404).end();
  }

  async function page(res, file) {
    let html;
    try {
      html = await fs.readFile(path.join(LAB, file), 'utf8');
    } catch {
      return res.writeHead(404).end();
    }
    // 매 요청마다 바뀌는 id (녹화 때와 재생 때 id 가 다르다)
    html = html.replaceAll('__RAND__', String(Math.floor(Math.random() * 9e6) + 1e6));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  }

  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const s = await startLab(Number(process.argv[2] || 4811));
  console.log(`RPA 실험실: http://127.0.0.1:${s.address().port}/  (아이디 ${LAB_USER.id} / 비밀번호 ${LAB_USER.pw})`);
}
