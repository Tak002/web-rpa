// 반복 점검용 작은 사이트: 쪽마다 4행인 3쪽짜리 거래처 표(상태 "정상/폐업"·금액·행마다 상세 링크, 마지막 쪽에는 "다음" 단추 없음),
// 상세 화면, 조건 확인 화면, 비밀값 입력 화면. 2·3쪽 표는 화면이 뜬 뒤 스크립트로 늦게 그린다(목록이 늦게 뜨는 사이트 흉내).
// 단독 실행: node test/loop-fixture/server.mjs 4930

import http from 'node:http';

export const COMPANIES = [
  ['가나상사', '정상', 12000],
  ['다라상사', '폐업', 8500],
  ['마바상사', '정상', 1500000],
  ['사아상사', '정상', 300],
  ['자차상사', '폐업', 45000],
  ['카타상사', '정상', 9999],
  ['파하상사', '정상', 10000],
  ['한빛상사', '폐업', 77000],
  ['누리상사', '정상', 5600],
  ['미래상사', '정상', 123456],
  ['보람상사', '폐업', 20],
  ['새솔상사', '정상', 64000],
];
export const PER_PAGE = 4;
export const PAGES = COMPANIES.length / PER_PAGE;
export const memoOf = (id) => `비고-${id} ${COMPANIES[id - 1][1]}`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:sans-serif;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 10px}</style></head>
<body>${body}</body></html>`;

function rowHtml(id) {
  const [name, state, amount] = COMPANIES[id - 1];
  return `<tr><td>${id}</td><td>${esc(name)}</td><td>${state}</td><td>${amount.toLocaleString('en-US')}</td><td><a href="detail.html?id=${id}">상세</a></td></tr>`;
}

function listPage(n) {
  const ids = Array.from({ length: PER_PAGE }, (_, i) => (n - 1) * PER_PAGE + i + 1);
  const rows = ids.map(rowHtml).join('');
  // 1쪽은 바로, 2·3쪽은 0.3초 뒤에 스크립트로 그린다
  const tbody = n === 1 ? `<tbody>${rows}</tbody>` : `<tbody id="later"></tbody><script>setTimeout(() => { document.getElementById('later').innerHTML = ${JSON.stringify(rows)}; }, 300);</script>`;
  const next = n < PAGES ? `<button id="next" type="button" onclick="location.href='list.html?page=${n + 1}'">다음</button>` : '';
  return page(
    `거래처 목록 ${n}쪽`,
    `<h2>거래처 결과</h2>
<table id="result" class="grid"><thead><tr><th>번호</th><th>상호</th><th>상태</th><th>금액</th><th>상세</th></tr></thead>${tbody}</table>
<p id="pageno">쪽 ${n} / ${PAGES}</p>
<p><input id="memo" placeholder="메모" style="width:400px"></p>
${next}`,
  );
}

function detailPage(id) {
  const [name] = COMPANIES[id - 1];
  return page(`${name} 상세`, `<h1 id="name">${esc(name)}</h1><p id="memo-text">${esc(memoOf(id))}</p><a href="list.html?page=1">목록으로</a>`);
}

const COND_PAGE = page(
  '조건 확인',
  `<h2>조건 확인</h2>
<span id="total">합계 12,000원</span>
<ul id="fruits"><li class="it">사과</li><li class="it">배</li><li class="it">감</li></ul>
<div id="cards"><div class="card">하나</div><div class="card">둘</div></div>
<input id="amount" value="12,000">`,
);

const SECRET_PAGE = page(
  '비밀값 입력',
  `<h2>로그인</h2>
<label for="pin">접속 번호</label> <input id="pin" type="text"> <span id="echo">입력 전</span>
<script>document.getElementById('pin').addEventListener('input', (e) => { document.getElementById('echo').textContent = '입력됨 (' + e.target.value.length + '자)'; });</script>`,
);

/** @returns {Promise<{server: http.Server, base: string, hits: Map<string, number>, close: () => Promise<void>}>} */
export async function startLoopSite(ports = [4930, 4931, 4932, 4933, 4934, 4935, 4936, 4937, 4938, 4939]) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = url.pathname + (url.searchParams.get('id') ? `?id=${url.searchParams.get('id')}` : '');
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const send = (code, html) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    };
    if (url.pathname === '/list.html') {
      const n = Math.min(Math.max(Number(url.searchParams.get('page')) || 1, 1), PAGES);
      return send(200, listPage(n));
    }
    if (url.pathname === '/empty.html') return send(200, page('빈 목록', `<h2>거래처 결과</h2><table id="result"><thead><tr><th>번호</th></tr></thead><tbody></tbody></table>`));
    if (url.pathname === '/detail.html') {
      const id = Number(url.searchParams.get('id'));
      if (!(id >= 1 && id <= COMPANIES.length)) return send(404, page('없음', '없는 거래처'));
      return send(200, detailPage(id));
    }
    if (url.pathname === '/cond.html') return send(200, COND_PAGE);
    if (url.pathname === '/secret.html') return send(200, SECRET_PAGE);
    return send(404, page('없음', '없는 화면'));
  });
  let lastErr;
  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return { server, base: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`반복 점검 사이트를 열 포트가 없습니다 (${ports[0]}–${ports.at(-1)}): ${lastErr?.message}`);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const port = Number(process.argv[2]) || 4930;
  const site = await startLoopSite([port]);
  console.log(`반복 점검 사이트: ${site.base}/list.html`);
}
