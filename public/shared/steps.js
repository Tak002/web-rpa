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
};

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
  let name = m.label || m.text || m.name || m.placeholder || '';
  const cands = Array.isArray(target.candidates) ? [...target.candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) : [];
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
  return `"${targetName(target)}"${word ? ` ${word}` : ''}${frame}${shadow}`;
}

/** 조건을 읽는 문장으로 */
export function conditionText(cond) {
  if (!cond || typeof cond !== 'object') return '(조건 없음)';
  switch (cond.kind) {
    case 'exists':
      return `${targetText(cond.target)} ${cond.visible ? '보임' : '있음'}`;
    case 'textVisible':
      return `화면에 ${q(cond.text)} 글자${cond.exact ? '(정확히 일치)' : ''} 보임`;
    case 'urlContains':
      return `주소에 ${q(cond.value)} 포함`;
    case 'varEquals':
      return `{{${cond.var ?? '?'}}} 값이 ${q(cond.value)}`;
    case 'dialogContains':
      return `알림창 문구에 ${q(cond.value)} 포함`;
    case 'not':
      return `아님(${conditionText(cond.condition)})`;
    case 'all':
      return (cond.conditions ?? []).map(conditionText).join(' 그리고 ') || '(조건 없음)';
    case 'any':
      return (cond.conditions ?? []).map(conditionText).join(' 또는 ') || '(조건 없음)';
    default:
      return `알 수 없는 조건(${cond.kind})`;
  }
}

const seconds = (ms) => `${Math.round((Number(ms) / 1000) * 10) / 10}초`;

/** 스텝 한 줄 설명 */
export function stepText(step) {
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
      return `${conditionText(s.condition)} 때까지 기다리기${s.timeoutMs ? ` (최대 ${seconds(s.timeoutMs)})` : ''}`;
    case 'sleep':
      return `${seconds(s.ms ?? 0)} 쉬기`;
    case 'extract':
      return `${name}의 ${s.attr ? `${s.attr} 속성` : '글자'} 읽어 {{${s.saveAs || '?'}}}에 저장`;
    case 'assert':
      return `확인: ${conditionText(s.condition)}${s.onFail === 'warn' ? ' (아니면 경고만)' : ' (아니면 행 실패)'}`;
    case 'branch':
      return `${conditionText(s.condition)} 이면 [${s.then || '?'}] 블록${s.else ? `, 아니면 [${s.else}] 블록` : ''} 실행`;
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
    default:
      return `${STEP_LABELS[s.type] ?? s.type ?? '?'}`;
  }
}
