// 스텝·대상·조건을 사람이 읽는 한국어로 바꾼다. 화면(브라우저)과 Node 가 함께 쓰는 ES 모듈 — Node 전용 API 를 쓰지 않는다.

export const STEP_LABELS = {
  navigate: '주소 이동',
  click: '클릭',
  dblclick: '더블클릭',
  input: '입력',
  select: '목록 선택',
  check: '체크',
  keypress: '키 누르기',
  wait: '조건 대기',
  sleep: '잠시 대기',
  extract: '값 읽기',
  assert: '확인',
  branch: '조건 분기',
  dialog: '알림창 응답',
  pdf: 'PDF 저장',
  screenshot: '화면 캡처',
  download: '다운로드 저장',
  upload: '파일 첨부',
  pause: '사용자 확인 대기',
  closeTab: '팝업 창 닫기',
  repeat: '반복',
  forEach: '목록의 항목마다',
};

/** 조건 비교 기호 (varCompare·elementCount 의 op) */
export const COMPARE_OPS = ['=', '!=', '>', '<', '>=', '<='];
const OP_SIGNS = { '=': '=', '!=': '≠', '>': '>', '<': '<', '>=': '≥', '<=': '≤' };
const COUNT_WORDS = { '=': (n) => `정확히 ${n}개`, '!=': (n) => `${n}개가 아님`, '>': (n) => `${n}개보다 많음`, '<': (n) => `${n}개보다 적음`, '>=': (n) => `${n}개 이상`, '<=': (n) => `${n}개 이하` };

const TAG_WORDS = {
  a: '링크',
  button: '버튼',
  select: '목록',
  textarea: '입력칸',
  td: '표 칸',
  th: '표 머리',
  tr: '표 줄',
  img: '그림',
  label: '라벨',
  li: '목록 항목',
  option: '옵션',
  summary: '펼침',
};
const INPUT_WORDS = { checkbox: '체크박스', radio: '라디오 버튼', file: '파일 칸', password: '비밀번호 칸', submit: '버튼', button: '버튼', image: '버튼' };

const clip = (s, n = 40) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const q = (s) => `"${clip(s)}"`;

/** 대상 요소의 보이는 이름 (따옴표 없이) */
export function targetName(target) {
  if (!target) return '';
  const m = target.meta ?? {};
  const cands = Array.isArray(target.candidates) ? [...target.candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) : [];
  if (target.within === 'item') {
    // 항목 안 대상은 견본 행의 글자(예: 첫 행 금액 "12,000") 대신 열 이름·라벨로 부른다 — 행마다 값이 다르다
    const stable = cands.find((c) => c.kind === 'text' && (c.score ?? 0) > 30)?.value?.text; // 다른 행에서도 같은 글자(예: "상세")
    const nth = cands.map((c) => /t[dh]:nth-(?:of-type|child)\((\d+)\)|\/t[dh]\[(\d+)\]/.exec(String(c.value ?? ''))).find(Boolean);
    const col = m.colIndex || Number(nth?.[1] ?? nth?.[2] ?? 0);
    return clip(m.col || m.label || m.name || m.placeholder || stable || (col ? `${col}번째 칸` : '')) || '항목 안 요소';
  }
  let name = m.label || m.text || m.name || m.placeholder || '';
  if (!name) name = cands.find((c) => c.kind === 'text')?.value?.text ?? '';
  if (!name && cands[0]) name = typeof cands[0].value === 'string' ? cands[0].value : (cands[0].value?.text ?? '');
  return clip(name) || '이름 없는 요소';
}

function kindWord(target) {
  const m = target?.meta ?? {};
  if (m.tag === 'input') return INPUT_WORDS[m.type] ?? '입력칸';
  return TAG_WORDS[m.tag] ?? '';
}

/** 대상 요소 한 줄 요약: "조회" 버튼 */
export function targetText(target) {
  if (!target) return '(대상 없음)';
  const word = kindWord(target);
  const frame = target.framePath?.length ? ' · 프레임 안' : '';
  const shadow = target.meta?.inShadow ? ' · 섀도 DOM' : '';
  const within = target.within === 'item' ? ' · 항목 안' : '';
  return `"${targetName(target)}"${word ? ` ${word}` : ''}${within}${frame}${shadow}`;
}

/** 받침이 있으면 a, 없으면 b (한글이 아니면 "a(b)") — 끝의 따옴표·괄호는 보지 않는다 */
function josa(word, a, b) {
  const ch = String(word ?? '').replace(/["'”’)\]\s]+$/, '').slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  if (!(code >= 0 && code <= 11171)) return /\d$/.test(ch) ? ('013678'.includes(ch) ? a : b) : `${a}(${b})`;
  return code % 28 ? a : b;
}
/** 낱말 + 조사 (예: withJosa('"조회" 버튼', '을', '를') → '"조회" 버튼을') */
export const withJosa = (word, a, b) => `${word}${josa(word, a, b)}`;
const varRef = (v) => `{{${String(v ?? '?').replace(/^\{\{|\}\}$/g, '').trim() || '?'}}}`;
const plain = (v) => (/^[\d\s,.\-+:/]+$/.test(String(v ?? '')) && String(v ?? '').trim() ? String(v).trim() : q(v));
const regexText = (pattern, flags) => `/${clip(pattern ?? '', 40)}/${flags ?? ''}`;

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
/** 조건 값: 비어 있으면 빈 따옴표("") 대신 무엇을 정해야 하는지 */
const qv = (v, what = '값') => (isBlank(v) ? `(${what}을 정하세요)` : q(v));
const pageText = (v) => (isBlank(v) ? '(보일 글자를 정하세요)' : q(v));

/** "아님(…)" 대신 자연스러운 부정 문장 (편집기 조건 문장과 같은 말) — 모르는 꼴이면 null */
function notText(c) {
  switch (c?.kind) {
    case 'exists':
      return `${targetText(c.target)} ${c.visible ? '안 보임' : '없음'}`;
    case 'textVisible':
      return `화면에 ${pageText(c.text)} 글자${c.exact ? '(정확히 일치)' : ''} 안 보임`;
    case 'urlContains':
      return `주소에 ${qv(c.value)} 없음`;
    case 'dialogContains':
      return `알림창 문구에 ${qv(c.value)} 없음`;
    case 'varContains':
      return `${varRef(c.var)} 에 ${qv(c.value)} 없음`;
    case 'varEquals':
      return `{{${c.var ?? '?'}}} 값이 ${qv(c.value)} 아님`;
    case 'varEmpty':
      return `${varRef(c.var)} 가 비어 있지 않음`;
    default:
      return null;
  }
}

/** 조건을 읽는 문장으로 */
export function conditionText(cond) {
  if (!cond || typeof cond !== 'object') return '(조건 없음)';
  switch (cond.kind) {
    case 'exists':
      return `${targetText(cond.target)} ${cond.visible ? '보임' : '있음'}`;
    case 'textVisible':
      return `화면에 ${pageText(cond.text)} 글자${cond.exact ? '(정확히 일치)' : ''} 보임`;
    case 'urlContains':
      return `주소에 ${qv(cond.value)} 포함`;
    case 'varEquals':
      return `{{${cond.var ?? '?'}}} 값이 ${qv(cond.value)}`;
    case 'dialogContains':
      return `알림창 문구에 ${qv(cond.value)} 포함`;
    case 'varContains':
      return `${varRef(cond.var)} 에 ${qv(cond.value)} 포함`;
    case 'varCompare':
      return `${varRef(cond.var)} ${OP_SIGNS[cond.op] ?? cond.op ?? '?'} ${plain(cond.value)}`;
    case 'varEmpty':
      return `${varRef(cond.var)} 가 비어 있음`;
    case 'matches':
      return `${varRef(cond.var)} 가 정규식 ${regexText(cond.pattern, cond.flags)} 에 맞음`;
    case 'elementText': {
      const el = `"${targetName(cond.target)}" 요소의 글자`;
      if (cond.op === 'equals') return `${el}가 ${q(cond.value)}`;
      if (cond.op === 'matches') return `${el}가 정규식 ${regexText(cond.value, cond.flags)} 에 맞음`;
      return `${el}에 ${q(cond.value)} 포함`;
    }
    case 'elementCount': {
      const n = Number(cond.value ?? 1);
      const word = COUNT_WORDS[cond.op ?? '>='] ?? ((x) => `${cond.op} ${x}개`);
      return `"${targetName(cond.target)}" 요소가 ${word(Number.isFinite(n) ? n : cond.value)}`;
    }
    case 'not':
      return notText(cond.condition) ?? `아님(${conditionText(cond.condition)})`;
    case 'all':
      return (cond.conditions ?? []).map(conditionText).join(' 그리고 ') || '(조건 없음)';
    case 'any':
      return (cond.conditions ?? []).map(conditionText).join(' 또는 ') || '(조건 없음)';
    default:
      return `알 수 없는 조건(${cond.kind})`;
  }
}

const seconds = (ms) => `${Math.round((Number(ms) / 1000) * 10) / 10}초`;

/** 반복 조건 문장: while → "…이 있는 동안", until → "…이 생길 때까지" */
function loopCondText(c, until) {
  if (!c || typeof c !== 'object') return '(조건 없음)';
  const el = (t) => {
    const s = targetText(t);
    return `${s}${josa(s.replace(/ · .*$/, ''), '이', '가')}`;
  };
  if (c.kind === 'exists') return until ? `${el(c.target)} ${c.visible ? '보일' : '생길'} 때까지` : `${el(c.target)} ${c.visible ? '보이는' : '있는'} 동안`;
  if (c.kind === 'not' && c.condition?.kind === 'exists') return until ? `${el(c.condition.target)} 없어질 때까지` : `${el(c.condition.target)} 없는 동안`;
  if (c.kind === 'textVisible') return `화면에 ${pageText(c.text)} 글자가 ${until ? '보일 때까지' : '보이는 동안'}`;
  return until ? `${conditionText(c)} 일 때까지` : `${conditionText(c)} 인 동안`;
}
const limitOf = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : 100);

/**
 * 반복이 끝난 이유 (실행 기록): until 이면 끝낼 조건이 맞아서, while 이면 조건이 더는 맞지 않아서.
 * 예: "다음" 버튼이 없어서 · 화면에 "완료" 글자가 보여서 · 조건({{n}} ≥ 3)이 맞아서
 */
export function loopEndText(c, until) {
  if (!c || typeof c !== 'object') return '조건이 없어서';
  const el = (t) => {
    const s = targetText(t);
    return `${s}${josa(s.replace(/ · .*$/, ''), '이', '가')}`;
  };
  const pos = c.kind === 'not' ? c.condition : c; // until 이 참 = c 가 맞음, while 이 거짓 = c 가 맞지 않음
  const want = c.kind === 'not' ? !until : until; // pos 가 "맞아서"(true) 끝났는지
  if (pos?.kind === 'exists') return want ? `${el(pos.target)} ${pos.visible ? '보여서' : '생겨서'}` : `${el(pos.target)} ${pos.visible ? '보이지 않아서' : '없어서'}`;
  if (pos?.kind === 'textVisible') return `화면에 ${pageText(pos.text)} 글자가 ${want ? '보여서' : '보이지 않아서'}`;
  return until ? `끝낼 조건(${conditionText(c)})이 맞아서` : `조건(${conditionText(c)})이 더는 맞지 않아서`;
}

/** 몸통·그러면·아니면 블록 요약: "안의 스텝 2개" (블록 이름 대신) */
function innerText(recipe, block) {
  const steps = recipe?.blocks?.[block];
  if (!Array.isArray(steps)) return `안의 스텝 없음 (블록 "${block ?? '?'}" 이 없습니다)`;
  const n = steps.filter((x) => x && !x.disabled).length;
  return n ? `안의 스텝 ${n}개` : '안의 스텝 없음';
}

/** 분기 조건 문장: "…이(가) 있으면", "{{상태}}에 "폐업"이 들어 있으면" */
function ifText(c) {
  if (!c || typeof c !== 'object') return '(조건 없음)이면';
  const el = (t) => {
    const s = targetText(t);
    return `${s}${josa(s.replace(/ · .*$/, ''), '이', '가')}`;
  };
  const has = (v) => (isBlank(v) ? `${qv(v)} 들어 있으면` : `${q(v)}${josa(clip(v), '이', '가')} 들어 있으면`);
  switch (c.kind) {
    case 'exists':
      return `${el(c.target)} ${c.visible ? '보이면' : '있으면'}`;
    case 'textVisible':
      return `화면에 ${pageText(c.text)} 글자가 보이면`;
    case 'urlContains':
      return `주소에 ${has(c.value)}`;
    case 'dialogContains':
      return `알림창 문구에 ${has(c.value)}`;
    case 'varEquals':
      return `${varRef(c.var)} 값이 ${q(c.value)}이면`;
    case 'varContains':
      return `${varRef(c.var)}에 ${has(c.value)}`;
    case 'varEmpty':
      return `${varRef(c.var)}${josa(String(c.var ?? '').replace(/[{}]/g, ''), '이', '가')} 비어 있으면`;
    case 'not':
      if (c.condition?.kind === 'exists') return `${el(c.condition.target)} ${c.condition.visible ? '보이지 않으면' : '없으면'}`;
      if (c.condition?.kind === 'textVisible') return `화면에 ${pageText(c.condition.text)} 글자가 보이지 않으면`;
      return `${conditionText(c)}이면`;
    default:
      return `${conditionText(c)} 이면`;
  }
}

/**
 * 스텝 한 줄 설명. recipe 를 주면 반복·분기의 몸통을 블록 이름 대신 "안의 스텝 N개" 로 말한다(화면·실행 기록용).
 * recipe 가 없으면 블록 이름으로 (AI 개요는 블록 이름을 쓴다).
 */
export function stepText(step, recipe) {
  if (!step || typeof step !== 'object') return '';
  const s = step;
  const name = q(targetName(s.target));
  const val = (v) => (v === undefined || v === null || v === '' ? '빈 값' : q(v));
  switch (s.type) {
    case 'navigate':
      return `${s.url ? clip(s.url, 80) : '(현재 주소)'} 열기`;
    case 'click':
      return `${name} 클릭`;
    case 'dblclick':
      return `${name} 더블클릭`;
    case 'input':
      return `${name}에 ${val(s.value)} 입력`;
    case 'select':
      return `${name}에서 ${val(s.label || s.value)} 고르기`;
    case 'check':
      return `${name} ${s.checked === false ? '체크 해제' : '체크'}`;
    case 'keypress':
      return `${s.key || '?'} 키 누르기${s.target ? ` (${name}에서)` : ''}`;
    case 'wait':
      return `${loopCondText(s.condition, true)} 기다리기${s.timeoutMs ? ` (최대 ${seconds(s.timeoutMs)})` : ''}`;
    case 'sleep':
      return `${seconds(s.ms ?? 0)} 쉬기`;
    case 'extract':
      return `${name}의 ${s.attr ? `${s.attr} 속성` : '글자'} 읽어 {{${s.saveAs || '?'}}}에 저장`;
    case 'assert':
      return `확인: ${conditionText(s.condition)}${s.onFail === 'warn' ? ' (아니면 경고만)' : ' (아니면 행 실패)'}`;
    case 'branch': {
      const c = s.condition;
      if (c?.kind === 'varCompare' && String(c.var ?? '').replace(/[{}\s]/g, '') === 'loop.index' && c.op === '>' && String(c.value).trim() === '1' && !s.else) {
        const only = recipe ? (recipe.blocks?.[s.then] ?? []).filter((x) => x && !x.disabled) : null;
        if (only?.length === 1) return `두 번째 반복부터 ${stepText(only[0])} (첫 번째에는 건너뜀)`; // 쪽 넘기기: 두 번째 반복부터 "다음" 클릭
        return `두 번째 반복부터: ${recipe ? innerText(recipe, s.then) : `[${s.then || '?'}] 스텝`} 실행 (첫 번째에는 건너뜀)`;
      }
      if (recipe) return `만약 ${ifText(c)} → 그러면 ${innerText(recipe, s.then)} 실행${s.else ? `, 아니면 ${innerText(recipe, s.else)} 실행` : ''}`;
      return `만약 ${ifText(c)} → [${s.then || '?'}] 스텝 실행${s.else ? `, 아니면 [${s.else}] 스텝 실행` : ''}`;
    }
    case 'dialog': {
      const msg = s.meta?.message ? ` — ${q(s.meta.message)}` : '';
      const text = s.promptText !== undefined && s.promptText !== null && s.action !== 'dismiss' ? ` (입력: ${q(s.promptText)})` : '';
      return `다음 알림창에 ${s.action === 'dismiss' ? '"취소"' : '"확인"'}${text}${msg}`;
    }
    case 'pdf':
      return `PDF 저장${s.fileName ? `: ${clip(s.fileName, 60)}` : ''}${s.landscape ? ' (가로)' : ''}`;
    case 'screenshot':
      return `화면 캡처${s.fileName ? `: ${clip(s.fileName, 60)}` : ''}${s.fullPage === false ? ' (보이는 부분만)' : ''}`;
    case 'download': {
      const file = s.fileName ? clip(s.fileName, 60) : s.meta?.suggestedFilename ? `원래 이름(${clip(s.meta.suggestedFilename, 40)})` : '사이트가 준 이름';
      return `${name} 눌러 파일 받기 → ${file}`;
    }
    case 'upload': {
      const names = s.meta?.fileNames?.length ? ` (녹화 때: ${clip(s.meta.fileNames.join(', '), 40)})` : '';
      return `${name}에 파일 첨부: ${s.path ? clip(s.path, 60) : '(경로를 지정하세요)'}${names}`;
    }
    case 'pause':
      return `사용자 확인 대기${s.message ? `: ${clip(s.message, 60)}` : ''}`;
    case 'closeTab':
      return '지금 팝업 창 닫기';
    case 'repeat': {
      const body = recipe ? innerText(recipe, s.body) : `${s.body || '?'} 블록`;
      if (s.times !== undefined && s.times !== null && s.times !== '') return `반복: ${s.times}번 → ${body}`;
      const how = s.until ? loopCondText(s.until, true) : s.while ? loopCondText(s.while, false) : '(반복 조건 없음)';
      return `반복: ${how} (최대 ${limitOf(s.maxIterations)}번) → ${body}`;
    }
    case 'forEach': {
      const back = s.restore === 'back' ? ', 항목마다 원래 화면으로 돌아옴' : '';
      return `목록의 항목마다: ${s.items ? targetName(s.items) : '(목록 없음)'} (최대 ${limitOf(s.maxItems)}개${back}) → ${recipe ? innerText(recipe, s.body) : `${s.body || '?'} 블록`}`;
    }
    default:
      return `${STEP_LABELS[s.type] ?? s.type ?? '?'}`;
  }
}
