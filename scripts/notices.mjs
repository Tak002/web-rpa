// 실제로 배포되는 의존성(package.json 의 dependencies 와 그 하위)의 라이선스 고지를 THIRD_PARTY_NOTICES.md 로 만든다.
// 실행: node scripts/notices.mjs [--check]   (--check: 허용 목록 밖 라이선스가 있으면 실패)

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ALLOWED = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|Unlicense|Zlib|MIT\/X11|\(MIT AND Zlib\)|\(MIT OR GPL-3\.0-or-later\))$/;
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** 패키지 dir 에서 의존성 dep 의 dir 을 찾는다. 위로 올라가며 node_modules/<dep> 를 본다 (pnpm 은 같은 node_modules 안의 형제). */
function resolveDep(fromDir, dep) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    const base = path.basename(d) === 'node_modules' ? d : path.join(d, 'node_modules');
    const dir = path.join(base, dep);
    if (fs.existsSync(path.join(dir, 'package.json'))) return fs.realpathSync(dir);
    if (path.dirname(d) === d) return null;
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return '';
}

const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const seen = new Map();
const queue = Object.keys(root.dependencies ?? {}).map((d) => [ROOT, d]);
while (queue.length) {
  const [from, dep] = queue.shift();
  const dir = resolveDep(from, dep);
  if (!dir) throw new Error(`의존성을 찾지 못했습니다: ${dep} (${from})`);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  const files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f));
  seen.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: licenseOf(pkg),
    repo: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? pkg.homepage ?? '',
    texts: files.map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8').trim() })),
  });
  for (const d of Object.keys(pkg.dependencies ?? {})) queue.push([dir, d]);
}

const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const bad = list.filter((p) => !ALLOWED.test(p.license));
const lines = [
  '# 제3자 소프트웨어 고지 (Third-party notices)',
  '',
  'web-rpa 를 실행할 때 함께 배포·설치되는 오픈소스 패키지와 그 라이선스입니다. `node scripts/notices.mjs` 로 다시 만듭니다.',
  '',
  '| 패키지 | 버전 | 라이선스 |',
  '|---|---|---|',
  ...list.map((p) => `| ${p.name} | ${p.version} | ${p.license || '표기 없음'} |`),
  '',
  '- `jszip` 은 MIT 또는 GPL-3.0 중 하나를 고를 수 있으며, web-rpa 는 MIT 조건으로 사용합니다.',
  '- `buffers@0.1.1` 은 패키지에 라이선스 표기가 없습니다(exceljs → unzipper → binary 의 하위 의존성). 같은 저자의 패키지들은 MIT/X11 로 배포됩니다.',
  '- 브라우저(Edge·Chrome·Brave)는 함께 배포하지 않고 사용자의 PC 에 설치된 것을 씁니다.',
  '',
  '---',
  '',
];
for (const p of list) {
  lines.push(`## ${p.name}@${p.version} — ${p.license || '표기 없음'}`, '');
  if (p.repo) lines.push(`출처: ${p.repo.replace(/^git\+/, '')}`, '');
  if (!p.texts.length) lines.push('(패키지에 라이선스 파일이 없습니다.)', '');
  for (const t of p.texts) lines.push('```text', t.text, '```', '');
}
fs.writeFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'));
console.log(`패키지 ${list.length}개 → THIRD_PARTY_NOTICES.md`);
if (bad.length) {
  console.log(`허용 목록 밖: ${bad.map((p) => `${p.name}@${p.version} (${p.license || '표기 없음'})`).join(', ')}`);
  if (process.argv.includes('--check') && bad.some((p) => p.name !== 'buffers')) process.exit(1);
}
