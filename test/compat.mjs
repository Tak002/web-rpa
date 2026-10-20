// 호환성 시험: 이전 버전과 같은 결과를 내는지 본다 — 날짜 토큰, 변수 치환, 파일 이름 정리, 레시피 검사, 엑셀 자동 연결, 엑셀·CSV 읽기, CSV 칸.
// 기준값은 이전 버전 엔진이 같은 입력으로 낸 결과다. 의도적으로 바뀐 것은 해당 줄 주석에 적었다.
// 실행: node test/compat.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { sysValue, Scope } from '../src/engine/vars.js';
import { safeFileName } from '../src/engine/naming.js';
import { recipeProblems, excelColumnsOf, promptVariablesOf, referencedNames, autoLinkExcel } from '../src/recipe.js';
import { readTable } from '../src/engine/excel.js';
import { csvCell } from '../src/engine/report.js';

const OUT = path.join(import.meta.dirname, 'out', 'compat');
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failures.push(`${name}\n    기대: ${JSON.stringify(expected)}\n    실제: ${JSON.stringify(actual)}`);
  }
}
const attempt = (f) => {
  try {
    return f();
  } catch {
    return null; // 오류
  }
};

// ---- 날짜 토큰 [기준 시각, 토큰, 기대값(null = 오류)]
const SYS = [["2026-01-31T10:20:30","sys:year","2026"],["2026-01-31T10:20:30","sys:month","1"],["2026-01-31T10:20:30","sys:day","31"],["2026-01-31T10:20:30","sys:quarter","1분기"],["2026-01-31T10:20:30","sys:month:-1","12"],["2026-01-31T10:20:30","sys:month:+1","2"],["2026-01-31T10:20:30","sys:month:-12","1"],["2026-01-31T10:20:30","sys:year:-1","2025"],["2026-01-31T10:20:30","sys:day:-1","30"],["2026-01-31T10:20:30","sys:day:+1","1"],["2026-01-31T10:20:30","sys:quarter:-1","4분기"],["2026-01-31T10:20:30","sys:quarter:+1","2분기"],["2026-01-31T10:20:30","sys:date","2026-01-31"],["2026-01-31T10:20:30","sys:date:YYYYMMDD","20260131"],["2026-01-31T10:20:30","sys:date:YYYY-MM-DD","2026-01-31"],["2026-01-31T10:20:30","sys:date:YYYY.MM","2026.01"],["2026-01-31T10:20:30","sys:date:YYYYMM:-1","202512"],["2026-01-31T10:20:30","sys:date:YYYYMMDD:-1","20260130"],["2026-01-31T10:20:30","sys:date:YYYY년 M월","2026년 1월"],["2026-01-31T10:20:30","sys:date:YYYY년 MM월:-1","2025년 12월"],["2026-01-31T10:20:30","sys:date:YY","26"],["2026-01-31T10:20:30","sys:date:HHmmss","102030"],["2026-01-31T10:20:30","sys:date:M/D","1/31"],["2026-01-31T10:20:30","sys:date:YYYY:+1","2027"],["2026-03-31T23:59:58","sys:year","2026"],["2026-03-31T23:59:58","sys:month","3"],["2026-03-31T23:59:58","sys:day","31"],["2026-03-31T23:59:58","sys:quarter","1분기"],["2026-03-31T23:59:58","sys:month:-1","2"],["2026-03-31T23:59:58","sys:month:+1","4"],["2026-03-31T23:59:58","sys:month:-12","3"],["2026-03-31T23:59:58","sys:year:-1","2025"],["2026-03-31T23:59:58","sys:day:-1","30"],["2026-03-31T23:59:58","sys:day:+1","1"],["2026-03-31T23:59:58","sys:quarter:-1","4분기"],["2026-03-31T23:59:58","sys:quarter:+1","2분기"],["2026-03-31T23:59:58","sys:date","2026-03-31"],["2026-03-31T23:59:58","sys:date:YYYYMMDD","20260331"],["2026-03-31T23:59:58","sys:date:YYYY-MM-DD","2026-03-31"],["2026-03-31T23:59:58","sys:date:YYYY.MM","2026.03"],["2026-03-31T23:59:58","sys:date:YYYYMM:-1","202602"],["2026-03-31T23:59:58","sys:date:YYYYMMDD:-1","20260330"],["2026-03-31T23:59:58","sys:date:YYYY년 M월","2026년 3월"],["2026-03-31T23:59:58","sys:date:YYYY년 MM월:-1","2026년 02월"],["2026-03-31T23:59:58","sys:date:YY","26"],["2026-03-31T23:59:58","sys:date:HHmmss","235958"],["2026-03-31T23:59:58","sys:date:M/D","3/31"],["2026-03-31T23:59:58","sys:date:YYYY:+1","2027"],["2024-02-29T08:05:09","sys:year","2024"],["2024-02-29T08:05:09","sys:month","2"],["2024-02-29T08:05:09","sys:day","29"],["2024-02-29T08:05:09","sys:quarter","1분기"],["2024-02-29T08:05:09","sys:month:-1","1"],["2024-02-29T08:05:09","sys:month:+1","3"],["2024-02-29T08:05:09","sys:month:-12","2"],["2024-02-29T08:05:09","sys:year:-1","2023"],["2024-02-29T08:05:09","sys:day:-1","28"],["2024-02-29T08:05:09","sys:day:+1","1"],["2024-02-29T08:05:09","sys:quarter:-1","4분기"],["2024-02-29T08:05:09","sys:quarter:+1","2분기"],["2024-02-29T08:05:09","sys:date","2024-02-29"],["2024-02-29T08:05:09","sys:date:YYYYMMDD","20240229"],["2024-02-29T08:05:09","sys:date:YYYY-MM-DD","2024-02-29"],["2024-02-29T08:05:09","sys:date:YYYY.MM","2024.02"],["2024-02-29T08:05:09","sys:date:YYYYMM:-1","202401"],["2024-02-29T08:05:09","sys:date:YYYYMMDD:-1","20240228"],["2024-02-29T08:05:09","sys:date:YYYY년 M월","2024년 2월"],["2024-02-29T08:05:09","sys:date:YYYY년 MM월:-1","2024년 01월"],["2024-02-29T08:05:09","sys:date:YY","24"],["2024-02-29T08:05:09","sys:date:HHmmss","080509"],["2024-02-29T08:05:09","sys:date:M/D","2/29"],["2024-02-29T08:05:09","sys:date:YYYY:+1","2025"],["2026-10-20T09:00:00","sys:year","2026"],["2026-10-20T09:00:00","sys:month","10"],["2026-10-20T09:00:00","sys:day","20"],["2026-10-20T09:00:00","sys:quarter","4분기"],["2026-10-20T09:00:00","sys:month:-1","9"],["2026-10-20T09:00:00","sys:month:+1","11"],["2026-10-20T09:00:00","sys:month:-12","10"],["2026-10-20T09:00:00","sys:year:-1","2025"],["2026-10-20T09:00:00","sys:day:-1","19"],["2026-10-20T09:00:00","sys:day:+1","21"],["2026-10-20T09:00:00","sys:quarter:-1","3분기"],["2026-10-20T09:00:00","sys:quarter:+1","1분기"],["2026-10-20T09:00:00","sys:date","2026-10-20"],["2026-10-20T09:00:00","sys:date:YYYYMMDD","20261020"],["2026-10-20T09:00:00","sys:date:YYYY-MM-DD","2026-10-20"],["2026-10-20T09:00:00","sys:date:YYYY.MM","2026.10"],["2026-10-20T09:00:00","sys:date:YYYYMM:-1","202609"],["2026-10-20T09:00:00","sys:date:YYYYMMDD:-1","20261019"],["2026-10-20T09:00:00","sys:date:YYYY년 M월","2026년 10월"],["2026-10-20T09:00:00","sys:date:YYYY년 MM월:-1","2026년 09월"],["2026-10-20T09:00:00","sys:date:YY","26"],["2026-10-20T09:00:00","sys:date:HHmmss","090000"],["2026-10-20T09:00:00","sys:date:M/D","10/20"],["2026-10-20T09:00:00","sys:date:YYYY:+1","2027"],["2026-12-31T12:00:00","sys:year","2026"],["2026-12-31T12:00:00","sys:month","12"],["2026-12-31T12:00:00","sys:day","31"],["2026-12-31T12:00:00","sys:quarter","4분기"],["2026-12-31T12:00:00","sys:month:-1","11"],["2026-12-31T12:00:00","sys:month:+1","1"],["2026-12-31T12:00:00","sys:month:-12","12"],["2026-12-31T12:00:00","sys:year:-1","2025"],["2026-12-31T12:00:00","sys:day:-1","30"],["2026-12-31T12:00:00","sys:day:+1","1"],["2026-12-31T12:00:00","sys:quarter:-1","3분기"],["2026-12-31T12:00:00","sys:quarter:+1","1분기"],["2026-12-31T12:00:00","sys:date","2026-12-31"],["2026-12-31T12:00:00","sys:date:YYYYMMDD","20261231"],["2026-12-31T12:00:00","sys:date:YYYY-MM-DD","2026-12-31"],["2026-12-31T12:00:00","sys:date:YYYY.MM","2026.12"],["2026-12-31T12:00:00","sys:date:YYYYMM:-1","202611"],["2026-12-31T12:00:00","sys:date:YYYYMMDD:-1","20261230"],["2026-12-31T12:00:00","sys:date:YYYY년 M월","2026년 12월"],["2026-12-31T12:00:00","sys:date:YYYY년 MM월:-1","2026년 11월"],["2026-12-31T12:00:00","sys:date:YY","26"],["2026-12-31T12:00:00","sys:date:HHmmss","120000"],["2026-12-31T12:00:00","sys:date:M/D","12/31"],["2026-12-31T12:00:00","sys:date:YYYY:+1","2027"]];
for (const [iso, token, want] of SYS) check(`날짜 ${iso} {{${token}}}`, attempt(() => sysValue(token, new Date(iso))), want);

// ---- 변수 치환 [실행 입력값, 템플릿, 기대값(null = 오류)] — 행 번호 3
const RECIPE = {
  variables: [
    { id: '상호', name: '상호', source: { kind: 'excel', column: '상호' } },
    { id: 'v2', name: '번호', source: { kind: 'excel', column: '사업자번호' } },
    { id: '고정', name: '고정', source: { kind: 'static', value: '지점-{{상호}}' } },
    { id: '암호', name: '암호', source: { kind: 'prompt', secret: true } },
    { id: '기본', name: '기본', source: { kind: 'prompt', default: '기본값' } },
  ],
  blocks: { main: [] },
};
const ROW = { 상호: ' 가나 상사 ', 사업자번호: '012-34-56789', 기타: 'x' };
const SUBST = [[{"암호":"pw!"},"{{상호}}"," 가나 상사 "],[{"암호":"pw!"},"{{상호|trim}}","가나 상사"],[{"암호":"pw!"},"{{번호|digits}}","0123456789"],[{"암호":"pw!"},"{{v2}}","012-34-56789"],[{"암호":"pw!"},"{{고정}}","지점- 가나 상사 "],[{"암호":"pw!"},"{{암호}}","pw!"],[{"암호":"pw!"},"{{기본}}","기본값"],[{"암호":"pw!"},"{{기타}}","x"],[{"암호":"pw!"},"{{없음}}",null],[{"암호":"pw!"},"{{row}}","3"],[{"암호":"pw!"},"{{상호|upper}}"," 가나 상사 "],[{"암호":"pw!"},"Abc{{상호|lower}}","Abc 가나 상사 "],[{"암호":"pw!"},"{{상호|trim|upper}}","가나 상사"],[{"암호":"pw!"},"{{없음|default:빈}}","빈"],[{"암호":"pw!"},"{{기타|default:빈}}","x"],[{"암호":"pw!"},"{{  상호  }}"," 가나 상사 "],[{"암호":"pw!"},"앞 {{번호|digits}} 뒤","앞 0123456789 뒤"],[{"암호":"pw!"},"{{상호|모름}}",null],[{"암호":"pw!"},"{{lastDialogMessage}}",""],[{"암호":"pw!"},"값 $1 {{상호}}","값 $1  가나 상사 "],[{},"{{상호}}"," 가나 상사 "],[{},"{{상호|trim}}","가나 상사"],[{},"{{번호|digits}}","0123456789"],[{},"{{v2}}","012-34-56789"],[{},"{{고정}}","지점- 가나 상사 "],[{},"{{암호}}",null],[{},"{{기본}}","기본값"],[{},"{{기타}}","x"],[{},"{{없음}}",null],[{},"{{row}}","3"],[{},"{{상호|upper}}"," 가나 상사 "],[{},"Abc{{상호|lower}}","Abc 가나 상사 "],[{},"{{상호|trim|upper}}","가나 상사"],[{},"{{없음|default:빈}}","빈"],[{},"{{기타|default:빈}}","x"],[{},"{{  상호  }}"," 가나 상사 "],[{},"앞 {{번호|digits}} 뒤","앞 0123456789 뒤"],[{},"{{상호|모름}}",null],[{},"{{lastDialogMessage}}",""],[{},"값 $1 {{상호}}","값 $1  가나 상사 "]]; // {{없음|default:빈}}: 이전 버전은 오류, 지금은 기본값 (오류였던 경우만 바뀜)
for (const [params, tpl, want] of SUBST) check(`치환 ${JSON.stringify(params)} ${tpl}`, attempt(() => new Scope({ recipe: RECIPE, row: ROW, rowNumber: 3, params }).resolve(tpl)), want);

// ---- 파일 이름 [입력, 기대값(null = 오류)]
const NAMES = [["보고서.pdf","보고서.pdf"],["a/b\\c:d*e?f\"g<h>i|j.txt","a_b_c_d_e_f_g_h_i_j.txt"],["끝에 점...","끝에 점"],["끝 공백   ","끝 공백"],["CON","_CON"],["con.txt","_con.txt"],["NUL.pdf","_NUL.pdf"],["COM1","_COM1"],["lpt9.csv","_lpt9.csv"],["   ",null],["",null],["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.xlsx","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.xlsx"],["가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가","가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가"],["탭\t줄\n바꿈.txt","탭_줄_바꿈.txt"],[" 앞뒤 공백 .pdf","앞뒤 공백 .pdf"],["a..b.pdf","a..b.pdf"]];
for (const [name, want] of NAMES) check(`파일 이름 ${JSON.stringify(name).slice(0, 40)}`, attempt(() => safeFileName(name)), want);

// ---- 레시피 검사: 문제 개수
const T1 = { framePath: [], candidates: [{ kind: 'css', value: '#a', score: 90 }], meta: {} };
const R = (blocks, extra = {}) => ({ name: '시험', entryBlock: 'main', blocks, variables: [], ...extra });
const RECIPES = {
  정상: R({ main: [{ id: 's1', type: 'navigate', url: 'https://x' }, { id: 's2', type: 'input', target: T1, value: '{{상호}}' }] }, { variables: [{ id: '상호', name: '상호', source: { kind: 'excel', column: '상호' } }] }),
  이름없음: { ...R({ main: [] }), name: '' },
  블록없음: { name: 'a' },
  시작블록없음: R({ other: [] }),
  id중복: R({ main: [{ id: 's1', type: 'sleep' }, { id: 's1', type: 'sleep' }] }),
  id없음: R({ main: [{ type: 'sleep' }] }),
  모르는종류: R({ main: [{ id: 's1', type: 'fly' }] }),
  대상없음: R({ main: [{ id: 's1', type: 'click' }] }),
  주소없음: R({ main: [{ id: 's1', type: 'navigate' }] }),
  값읽기이름없음: R({ main: [{ id: 's1', type: 'extract', target: T1 }] }),
  분기블록없음: R({ main: [{ id: 's1', type: 'branch', condition: { kind: 'urlContains', value: 'a' }, then: '없는블록' }] }),
  분기then없음: R({ main: [{ id: 's1', type: 'branch', condition: { kind: 'urlContains', value: 'a' } }] }),
  분기조건없음: R({ main: [{ id: 's1', type: 'branch', then: 'main' }] }),
  대기조건없음: R({ main: [{ id: 's1', type: 'wait' }, { id: 's2', type: 'assert' }] }),
  정의안된변수: R({ main: [{ id: 's1', type: 'navigate', url: 'https://x/{{모름}}' }] }),
  예약변수: R({ main: [{ id: 's1', type: 'navigate', url: 'https://x/{{row}}/{{sys:date:YYYY}}/{{lastDialogMessage}}' }] }),
  값읽기변수: R({ main: [{ id: 's1', type: 'extract', target: T1, saveAs: '금액' }, { id: 's2', type: 'input', target: T1, value: '{{금액}}' }] }),
  블록배열아님: R({ main: [], 다른: 'x' }),
};
const CHECKS = {"정상":0,"이름없음":1,"블록없음":1,"시작블록없음":1,"id중복":1,"id없음":1,"모르는종류":1,"대상없음":1,"주소없음":1,"값읽기이름없음":1,"분기블록없음":1,"분기then없음":1,"분기조건없음":1,"대기조건없음":2,"정의안된변수":1,"예약변수":0,"값읽기변수":0,"블록배열아님":1};
for (const [k, r] of Object.entries(RECIPES)) check(`레시피 검사 ${k} (문제 개수)`, recipeProblems(r).length, CHECKS[k]);

// ---- 엑셀 열·입력 변수·참조 이름
const COLS = R(
  { main: [{ id: 's1', type: 'input', target: T1, value: '{{상호}} {{번호|digits}}' }, { id: 's2', type: 'navigate', url: '{{고정}}' }, { id: 's3', type: 'input', target: T1, value: '{{비번}}' }] },
  {
    variables: [
      { id: '상호', name: '상호', source: { kind: 'excel', column: '상호' } },
      { id: 'v2', name: '번호', source: { kind: 'excel', column: '사업자번호' } },
      { id: '안씀', name: '안씀', source: { kind: 'excel', column: '안씀' } },
      { id: '고정', name: '고정', source: { kind: 'static', value: '{{지점}}' } },
      { id: '지점', name: '지점', source: { kind: 'excel', column: '지점' } },
      { id: 'p', name: '비번', source: { kind: 'prompt', secret: true } },
      { id: 'p2', name: '안쓰는입력', source: { kind: 'prompt' } },
    ],
  },
);
check('엑셀 열', excelColumnsOf(COLS), ["상호","사업자번호","지점"]);
check('입력 변수', promptVariablesOf(COLS).map((v) => v.id), ["p"]);
check('참조 이름', [...referencedNames(COLS)].sort(), ["고정","번호","비번","상호","지점"]);

// ---- 엑셀 자동 연결
const REC = R({
  main: [
    { id: 's1', type: 'input', target: T1, value: '1234567890' },
    { id: 's2', type: 'input', target: T1, value: '가나상사' },
    { id: 's3', type: 'select', target: T1, value: 'P1', label: '1기 (예정+확정)' },
    { id: 's4', type: 'input', target: T1, value: '같은값' },
    { id: 's5', type: 'input', target: T1, value: '{{이미}}' },
    { id: 's6', type: 'input', target: T1, value: ' 가나상사 ' },
    { id: 's7', type: 'select', target: T1, value: 'X', label: '없는라벨' },
  ],
});
const linked = autoLinkExcel(structuredClone(REC), ['사업자번호', '상호', '기간', 'A', 'B'], { 사업자번호: '1234567890', 상호: '가나상사', 기간: '1기 (예정+확정)', A: '같은값', B: '같은값' });
check(
  '엑셀 자동 연결',
  { linked: linked.linked, values: linked.recipe.blocks.main.map((s) => [s.value, s.label ?? null, s.meta?.recordedValue ?? null]), vars: (linked.recipe.variables ?? []).map((v) => `${v.id}:${v.source.kind}:${v.source.column}`) },
  {"linked":[{"stepId":"s1","column":"사업자번호"},{"stepId":"s2","column":"상호"},{"stepId":"s3","column":"기간"},{"stepId":"s6","column":"상호"}],"values":[["{{사업자번호}}",null,"1234567890"],["{{상호}}",null,"가나상사"],["{{기간}}",null,"1기 (예정+확정)"],["같은값",null,null],["{{이미}}",null,null],["{{상호}}",null," 가나상사 "],["X","없는라벨",null]],"vars":["사업자번호:excel:사업자번호","상호:excel:상호","기간:excel:기간"]},
);

// ---- 엑셀·CSV 읽기 (모든 값은 문자열, 앞자리 0 보존)
await fs.mkdir(OUT, { recursive: true });
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('입력');
ws.addRow(['사업자번호', '상호', '금액', '날짜', '빈칸', ' 공백열 ']);
ws.addRow(['0123456789', '가나', 1000, new Date(Date.UTC(2026, 9, 20)), null, '  a  ']);
ws.addRow([1234567890, { richText: [{ text: '다' }, { text: '라' }] }, 12.5, '2026-10-20', '', 'b']);
ws.addRow([null, null, null, null, null, null]);
ws.addRow(['=1+1', { formula: '1+2', result: 3 }, true, null, null, 'c']);
await wb.xlsx.writeFile(path.join(OUT, 't.xlsx'));
await fs.writeFile(path.join(OUT, 'utf8.csv'), '\ufeff사업자번호,상호,비고\r\n0123456789,"가나, 상사","따옴표 ""안"""\r\n,,\r\n5558887777,마바,\r\n');
await fs.writeFile(path.join(OUT, 'lf.csv'), '열1,열2\n001,"줄\n바꿈"\n');
const TABLES = {"t.xlsx":{"headers":["사업자번호","상호","금액","날짜","빈칸","공백열"],"rows":[{"사업자번호":"0123456789","상호":"가나","금액":"1000","날짜":"2026-10-20","빈칸":"","공백열":"  a  "},{"사업자번호":"1234567890","상호":"다라","금액":"12.5","날짜":"2026-10-20","빈칸":"","공백열":"b"},{"사업자번호":"=1+1","상호":"3","금액":"TRUE","날짜":"","빈칸":"","공백열":"c"}]},"utf8.csv":{"headers":["사업자번호","상호","비고"],"rows":[{"사업자번호":"0123456789","상호":"가나, 상사","비고":"따옴표 \"안\""},{"사업자번호":"5558887777","상호":"마바","비고":""}]},"lf.csv":{"headers":["열1","열2"],"rows":[{"열1":"001","열2":"줄\n바꿈"}]}};
for (const [f, want] of Object.entries(TABLES)) check(`엑셀 읽기 ${f}`, await readTable(path.join(OUT, f)), want);

// ---- CSV 칸: 이전 버전은 모든 칸을 따옴표로 감쌌다. 지금은 필요할 때만 감싸므로, 엑셀이 읽는 값(따옴표를 벗긴 값)으로 비교한다.
const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);
const CSV = [["=SUM(A1)","\"'=SUM(A1)\""],["+1","\"'+1\""],["-1","\"-1\""],["@x","\"'@x\""],["a,b","\"a,b\""],["줄\n바꿈","\"줄\n바꿈\""],["따옴\"표","\"따옴\"\"표\""],[12,"\"12\""],[null,"\"\""],["평범","\"평범\""]];
for (const [v, want] of CSV) check(`CSV 칸 ${JSON.stringify(v)}`, unquote(csvCell(v)), unquote(want));

console.log(`호환성 시험: ${passed}/${passed + failures.length} 통과`);
if (failures.length) {
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log('✅ 호환성 시험 통과');
