// 공개 전 점검: 저장소에 올라갈 파일에 비밀값·개인 경로·사설 IP 가 없는지, 필수 파일과 .gitignore 가 갖춰졌는지 본다.
//   업데이트 서명 개인 키: 저장소 어디에도(dist·workspace 포함) .pem·.key·.p12·.pfx 파일이나 Ed25519 개인 키 내용이 있으면 실패한다.
// 실행: node scripts/check-release.mjs   (문제가 있으면 목록을 출력하고 실패한다)

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const IGNORED_DIRS = new Set(['node_modules', 'workspace', 'dist', '.git']);
const IGNORED_PATHS = ['test/out', 'test/out-lab'];
const TEXT_EXT = /\.(js|mjs|cjs|json|md|html|css|cmd|ps1|txt|yaml|yml|iss)$/i;
// 키 파일: 이름만으로 실패 (dist·workspace 안도 본다 — 릴리스 파일·작업 폴더에 섞이지 않게)
const KEY_FILE = /\.(pem|key|p12|pfx)$/i;
const KEY_SCAN_SKIP = new Set(['node_modules', '.git', 'profiles']); // 브라우저 프로필은 크고 키 파일을 두지 않는다

const PRIVATE_KEY_RULES = [
  { name: '개인 키', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Ed25519 PKCS#8 DER 의 base64 머리 (302e020100300506032b657004220420) — PEM 머리 없이 붙여 넣은 개인 키
  { name: 'Ed25519 개인 키', re: /MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{20,}/ },
  // JWK 개인 키 (OKP/Ed25519 의 d 값)
  { name: 'Ed25519 개인 키 (JWK)', re: /"crv"\s*:\s*"Ed25519"[^}]*"d"\s*:\s*"|"d"\s*:\s*"[A-Za-z0-9_-]{43}"[^}]*"crv"\s*:\s*"Ed25519"/ },
];
const RULES = [
  { name: 'API 키', re: /\b(sk-or-v1-[0-9a-f]{16,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})\b/ },
  ...PRIVATE_KEY_RULES,
  { name: '로컬 사용자 경로', re: /[A-Za-z]:[\\/]+(Users|works)[\\/]/i },
  { name: '사설망 IP', re: /\b(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])|10\.\d{1,3}|192\.168)\.\d{1,3}\.\d{1,3}\b/ },
  { name: '이메일 주소', re: /\b[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, skip: /^pnpm-lock\.yaml$/ }, // 잠금 파일에는 패키지 저자 안내문이 들어 있다
];
// 시험용 사이트의 고정 계정(test/lab-server.mjs)과 라이선스 원문 속 저작권 표기는 허용한다.
const ALLOW = [/lab-pass-123/, /THIRD_PARTY_NOTICES\.md$/];

const relOf = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = relOf(p);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name) || IGNORED_PATHS.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
      yield* walk(p);
    } else if (TEXT_EXT.test(e.name)) yield rel;
  }
}

/** 키 찾기용: node_modules·.git 만 빼고 dist·workspace·시험 출력까지 모든 파일 */
function* walkAll(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!KEY_SCAN_SKIP.has(e.name)) yield* walkAll(p);
    } else if (e.isFile()) yield p;
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

// 서명 개인 키는 저장소 밖(%USERPROFILE%\.web-rpa-signing)에만 둔다
const scanned = new Set(walk(ROOT));
for (const p of walkAll(ROOT)) {
  const rel = relOf(p);
  if (KEY_FILE.test(p)) {
    problems.push(`${rel} 키 파일: 개인 키·인증서 파일은 저장소·dist·workspace 에 두지 마세요 (서명 키는 저장소 밖 %USERPROFILE%\\.web-rpa-signing)`);
    continue;
  }
  if (scanned.has(rel) || !TEXT_EXT.test(p) || fs.statSync(p).size > 5 * 1024 * 1024) continue; // 위에서 본 파일은 건너뛴다
  const text = fs.readFileSync(p, 'utf8');
  for (const r of PRIVATE_KEY_RULES) if (r.re.test(text)) problems.push(`${rel} ${r.name}: 개인 키 내용이 들어 있습니다`);
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
