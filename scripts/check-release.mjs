// 공개 전 점검: 저장소에 올라갈 파일에 비밀값·개인 경로·사설 IP 가 없는지, 필수 파일과 .gitignore 가 갖춰졌는지 본다.
// 실행: node scripts/check-release.mjs   (문제가 있으면 목록을 출력하고 실패한다)

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const IGNORED_DIRS = new Set(['node_modules', 'workspace', 'dist', '.git']);
const IGNORED_PATHS = ['test/out', 'test/out-lab'];
const TEXT_EXT = /\.(js|mjs|cjs|json|md|html|css|cmd|ps1|txt|yaml|yml)$/i;

const RULES = [
  { name: 'API 키', re: /\b(sk-or-v1-[0-9a-f]{16,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})\b/ },
  { name: '개인 키', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '로컬 사용자 경로', re: /[A-Za-z]:[\\/]+(Users|works)[\\/]/i },
  { name: '사설망 IP', re: /\b(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])|10\.\d{1,3}|192\.168)\.\d{1,3}\.\d{1,3}\b/ },
  { name: '이메일 주소', re: /\b[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, skip: /^pnpm-lock\.yaml$/ }, // 잠금 파일에는 패키지 저자 안내문이 들어 있다
];
// 시험용 사이트의 고정 계정(test/lab-server.mjs)과 라이선스 원문 속 저작권 표기는 허용한다.
const ALLOW = [/lab-pass-123/, /THIRD_PARTY_NOTICES\.md$/];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p).replaceAll('\\', '/');
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name) || IGNORED_PATHS.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
      yield* walk(p);
    } else if (TEXT_EXT.test(e.name)) yield rel;
  }
}

const problems = [];
for (const rel of walk(ROOT)) {
  if (ALLOW.some((a) => a.test(rel))) continue;
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const r of RULES) if (!r.skip?.test(rel) && r.re.test(line) && !ALLOW.some((a) => a.test(line))) problems.push(`${rel}:${i + 1} ${r.name}: ${line.trim().slice(0, 120)}`);
  });
}

for (const f of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) if (!fs.existsSync(path.join(ROOT, f))) problems.push(`필수 파일 없음: ${f}`);
const gitignore = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
for (const g of ['node_modules/', 'workspace/', 'test/out/', 'test/out-lab/', 'dist/']) if (!gitignore.split(/\r?\n/).includes(g)) problems.push(`.gitignore 에 ${g} 가 없습니다`);

if (problems.length) {
  console.log(`공개 전 점검: 문제 ${problems.length}건`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('공개 전 점검 통과');
