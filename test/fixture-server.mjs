// 테스트용 사이트: 매 요청마다 id 가 바뀌는 입력칸·버튼, 확인창, 늦게 뜨는 결과, iframe, 팝업, 인쇄 버튼.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURE = path.join(import.meta.dirname, 'fixture');

export function startFixture(port = 0) {
  const rand = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '1');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/download.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="data.txt"' });
      return res.end('자료');
    }
    if (url.pathname === '/report.csv') {
      // 서버가 파일을 만드는 데 시간이 걸리고, 새 창에서 다운로드가 시작되는 경우
      await new Promise((r) => setTimeout(r, 800));
      const b = url.searchParams.get('b') ?? '';
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="report_${encodeURIComponent(b)}.csv"` });
      return res.end(`사업자번호,금액\r\n${b},1000\r\n`);
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try {
      let html = await fs.readFile(path.join(FIXTURE, path.basename(file)), 'utf8');
      html = html.replaceAll('__BIZ_ID__', `bizno_${rand(7)}`).replaceAll('__SEARCH_SUFFIX__', rand(6));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

// 직접 실행하면 고정 포트로 띄운다: node test/fixture-server.mjs 4810
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const s = await startFixture(Number(process.argv[2] || 4810));
  console.log(`테스트 사이트: http://127.0.0.1:${s.address().port}/`);
}
