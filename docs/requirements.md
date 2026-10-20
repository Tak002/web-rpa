# web-rpa 엔진 요구사항

이 문서는 web-rpa 의 녹화기·실행 엔진·레시피 처리·브라우저 실행·AI 화면 관찰기를 새로 구현하기 위한 기능 요구사항이다.
화면(`public/app.js`), 로컬 서버(`src/server.js`, `src/store.js`, `src/settings.js`), AI 대화(`src/ai/agent.js`, `tools.js`, `openrouter.js`),
시험(`test/`)은 이미 있고 바꾸지 않는다. 새 모듈은 이들이 기대하는 인터페이스를 지켜야 한다.

- 런타임: Node 20+ ESM. 의존성은 `package.json` 의 `playwright-core`, `exceljs`, `pdf-lib` 만 쓴다.
- 코드·주석·사용자 메시지는 한국어로 쓴다. 주변 파일(`src/server.js` 등)의 문체와 밀도를 따른다.
- 이 문서에 정하지 않은 세부(점수 값, 대기 시간, 내부 구조, 이름)는 구현자가 정하고, 정한 값과 이유를 `docs/design-notes.md` 에 짧게 남긴다.

---

## 1. 만들 모듈과 공개 인터페이스

| 파일 | 내보내는 것 | 쓰는 곳 |
|---|---|---|
| `src/recorder/recorder.js` | `class Recorder` | server.js, test/e2e·lab·headed-check |
| `src/recorder/*.page.js` 등 | 페이지에 주입할 캡처 스크립트 (구성 자유) | recorder, observer |
| `src/engine/runner.js` | `class Runner` | server.js, observer, 시험 |
| `src/engine/excel.js` | `readTable(file)`, `writeTemplate(columns, file)` (+ 결과 엑셀 작성) | server.js |
| `src/engine/naming.js` | `safeFileName(name)` | store.js |
| `src/engine/*.js` | 그 밖의 엔진 모듈 (구성 자유) | — |
| `src/recipe.js` | `recipeProblems`, `excelColumnsOf`, `promptVariablesOf`, `autoLinkExcel`, `ensureExcelVariable`, `referencedNames` | server.js, tools.js, store.js, 시험 |
| `src/browser.js` | `BROWSERS`, `detectBrowsers()`, `profileNameFor(id)`, `startBrowser(opts)`, 프레임 경로 계산 함수 | server.js, settings.js, recorder, runner, observer |
| `src/ai/observer.js` | `class Observer`, `sampleRowFrom(recipe)` | agent.js, test/agent-mock |
| `public/shared/steps.js` | `STEP_LABELS`, `stepText(step)`, `targetText(target)`, `conditionText(cond)` | app.js(브라우저), tools.js, 시험 |

호출하는 쪽 코드를 읽어 정확한 사용법을 확인한다: `src/server.js`, `src/store.js`, `src/settings.js`, `src/ai/agent.js`, `src/ai/tools.js`, `public/app.js`, `test/*.mjs`.

### 1.1 Recorder

- `new Recorder({ name, startUrl, profileDir, headless = false, browser })`
- `start()` — 브라우저를 열고 `startUrl` 로 이동한다. 첫 스텝은 `navigate`.
- `pause()` / `resume()` — 일시정지 중 들어온 이벤트는 버린다.
- `addManualStep(step)` — 화면에서 직접 넣는 스텝. `navigate` 에 url 이 없으면 지금 탭 주소를 쓴다.
- `removeStep(id)`
- `stop()` → 레시피. 아직 보내지 않은 입력값(포커스를 잃지 않은 칸)까지 반영하고 브라우저를 닫는다.
- 속성: `state` (`idle`·`starting`·`recording`·`paused`·`stopped`), `recipe`(지금까지의 레시피), `ctx`(Playwright BrowserContext — 시험이 직접 조작한다).
- 이벤트: `change` `{ state, recipe }`, `warn` (문자열), `ended` `{ reason }` — 사용자가 브라우저를 닫아 끝난 경우.

### 1.2 Runner

- `new Runner({ recipe, runId, runDir, profileDir, excelPath, params = {}, options = {}, browser })`
  - `options`: `headless`, `humanPacing`, `recordVideo`, `startRow`(1부터), `maxRows`, `onRowError`(`'skip'`|`'stop'`, 기본은 `recipe.loop.onRowError` 또는 skip)
- `start()` → 리포트 객체. 성공·실패·중지 어느 경우에도 리포트 파일을 남기고 끝난다.
- `pause()`, `resume()`, `stop()`. `pause` 스텝(사용자 확인 대기) 중이면 상태가 `waiting-user` 가 되고 `resume()` 으로 이어간다.
- 속성: `status` (`idle`·`running`·`paused`·`waiting-user`·`done`·`failed`·`stopped`), `logLines`(문자열 배열).
- 이벤트(server.js 가 그대로 화면에 중계한다):
  - `log` `{ level, message, line }`
  - `status` `{ status, message?, report? }`
  - `progress` `{ rowsTotal, rowsDone, rowsFailed? }`
  - `step` `{ stepId, block, index, desc, rowNumber, status: 'start'|'ok'|'skip'|'fail', note?, error? }`
  - `row` — 행 시작 `{ rowNumber, label, status: 'start' }`, 끝나면 행 결과 객체
- 실패 행이 하나라도 있으면 최종 상태는 `failed`(부분 성공을 성공으로 보고하지 않는다).

### 1.3 Observer (AI 화면 관찰)

AI 도우미가 "이 스텝까지 실행한 화면"을 보고 새 요소를 고르게 해 준다. `src/ai/agent.js`, `src/ai/tools.js`, `test/agent-mock.mjs` 가 쓰는 방식을 그대로 지원한다.

- `new Observer({ recipe, profileDir, browser, sampleRow, allowRisky, onLog })`, `open()`, `runTo(stepId | null)`, `snapshot()`, `targetFor(ref)`, `close()`, 그리고 `recipe`·`sampleRow` 를 바꿔 다시 쓸 수 있다.
- 숨김 브라우저로 레시피를 지정 스텝까지 실행한다. 출력 스텝(PDF·다운로드·첨부)은 건너뛴다. 제출·신고·결제·삭제·발송처럼 되돌릴 수 없는 버튼은 `allowRisky` 가 아니면 누르지 않는다.
- 엑셀 변수는 `sampleRow` 값으로 채운다. `sampleRowFrom(recipe)` 는 엑셀 연결 때 남긴 녹화 값(`meta.recordedValue`)으로 견본 행을 만든다.
- `snapshot()` 은 화면 요소 목록 텍스트다. 형식은 `test/agent-mock.mjs` 의 단언을 만족해야 한다(실행 결과 머리말, 프레임 구분, 표 안 요소의 행 정보 등).
- `targetFor(ref)` 는 녹화기와 같은 규칙으로 만든 타겟 번들을 돌려준다.

### 1.4 browser.js

- `BROWSERS`: `{ id, label }` 목록. id 는 `auto`·`msedge`·`chrome`·`brave`·`chromium`·`custom` (settings.js·화면이 이 id 를 쓴다).
- `detectBrowsers()` → `[{ id, label, found, path }]`
- `profileNameFor(id)` — 브라우저마다 프로필 폴더를 나눈다. `auto`·`msedge`·없음은 `'default'` (기존 사용자 프로필 유지).
- `startBrowser({ profileDir, headless, viewport, browser, recordVideo })` → 영속 프로필 BrowserContext. 다운로드 허용, `ko-KR`.
  - `browser` 가 없으면 환경 변수 `WEB_RPA_BROWSER` 또는 `auto`. auto 는 Edge → Chrome → Brave → Playwright 내장 Chromium 순으로 설치된 것을 쓴다.
  - 프로필이 이미 쓰이는 중이면 알아듣기 쉬운 한국어 오류를 낸다.
  - `recordVideo: { dir, size }` 면 탭마다 동영상을 남긴다.
  - 컨텍스트에 사람이 읽는 브라우저 이름을 붙여 실행 로그에 남긴다.
  - 자동화 브라우저라는 이유로 사이트 동작이 달라지지 않게, 그리고 가려진 창에서도 타이머가 느려지지 않게 필요한 실행 인자를 정한다(인자 선택은 구현자 판단, 이유를 design-notes 에).

### 1.5 steps.js (브라우저와 Node 가 함께 쓰는 ES 모듈 — Node 전용 API 금지)

- `STEP_LABELS`: 스텝 종류 → 한국어 이름. 종류 목록은 §2.3 과 같다. 이름은 새로 정한다.
- `stepText(step)`: 사람이 읽는 한 줄. 대상 요소의 보이는 이름(라벨·글자)과 값·파일 이름 규칙 등을 담는다. 시험은 대상 글자가 문장에 들어 있는지로 스텝을 찾는다(예: "파일 찾기…").
- `targetText(target)`, `conditionText(cond)`.

---

## 2. 데이터 형식 (바꾸지 않는다 — 저장된 레시피와 화면·AI·시험이 쓴다)

### 2.1 레시피

```jsonc
{
  "schemaVersion": 1, "id": "…", "name": "…", "startUrl": "https://…", "createdAt": "…", "updatedAt": "…",
  "variables": [ { "id": "상호", "name": "상호", "source": { "kind": "excel", "column": "상호" } } ],
  "entryBlock": "main",
  "blocks": { "main": [ /* 스텝 */ ], "다른블록": [ ] },
  "loop": { "onRowError": "skip" }
}
```

- 변수 `source.kind`: `excel`(column) · `static`(value, 안에 `{{…}}` 가능) · `prompt`(실행 때 입력, `secret: true` 면 화면에 가림, `default` 가능)
- 블록: 이름 → 스텝 배열. 실행은 `entryBlock`(없으면 `main`)에서 시작한다.

### 2.2 타겟 번들 (화면 요소)

```jsonc
{
  "framePath": [ { "name": "inner", "url": "https://…/frame.html", "index": 0 } ],   // 바깥 → 안쪽 프레임
  "candidates": [ { "kind": "css" | "attr" | "xpath", "value": "선택자", "score": 90 },
                  { "kind": "text", "value": { "tag": "button", "text": "조회" }, "score": 70 } ],
  "meta": { "tag": "button", "type": "…", "text": "…", "label": "…", "name": "…", "inShadow": true, "rect": { "x": 0, "y": 0, "w": 0, "h": 0 } }
}
```

- `score` 가 클수록 믿을 만한 후보다. 사람이 손으로 쓴 레시피(시험의 B·C 시나리오)도 임의 점수로 후보를 넣는다 — 실행은 점수 순서만 쓴다.
- `attr` 은 속성 기반 CSS 선택자다(`css` 와 같은 방식으로 찾는다).
- 후보 값에도 `{{변수}}` 를 쓸 수 있다(예: xpath 안의 `{{대상월}}`). 찾기 전에 치환한다.

### 2.3 스텝

공통: `id`, `type`, `meta`(녹화 정보), `optional`, `onError: "continue"`, `attempts`(총 시도 횟수), `timeoutMs`, `disabled`.

| type | 필드 |
|---|---|
| `navigate` | `url` |
| `click`, `dblclick` | `target` |
| `input` | `target`, `value` |
| `select` | `target`, `value`, `label?` |
| `check` | `target`, `checked` (기본 true) |
| `keypress` | `key`, `target?` |
| `wait` | `condition` |
| `sleep` | `ms` |
| `extract` | `target`, `saveAs`, `attr?` |
| `assert` | `condition`, `message?`, `onFail?: "warn"` |
| `branch` | `condition`, `then`(블록 이름), `else?` |
| `dialog` | `action: "accept"|"dismiss"`, `promptText?` |
| `pdf` | `fileName?`, `format?`, `landscape?`, `settleMs?` |
| `screenshot` | `fileName?`, `fullPage?`(기본 true) |
| `download` | `target`, `fileName?`(비면 사이트가 준 이름) |
| `upload` | `target`, `path` |
| `pause` | `message?` |
| `closeTab` | — |

`meta` 필드 중 바깥에서 쓰는 것: `url`(녹화 당시 주소), `pageId`(녹화 중 탭 번호, 첫 탭 1), `ts`, `recordedGapMs`(직전 스텝과의 간격 — 사람 속도 재생용), `label`·`text`(대상 이름), 대화상자 스텝의 `dialogType`·`message`·`triggerStepId`(원인 스텝 id), 다운로드 스텝의 `suggestedFilename`, 첨부 스텝의 `fileNames`, 엑셀 연결 뒤의 `recordedValue`.

### 2.4 조건

`{ kind: "exists", target, visible? }` · `{ kind: "textVisible", text, exact? }`(모든 프레임) · `{ kind: "urlContains", value }` ·
`{ kind: "varEquals", var, value }` · `{ kind: "dialogContains", value }`(이번 행의 마지막 대화상자 문구) · `not` · `all` · `any`.
조건에서 정의 안 된 변수는 거짓. `exists` 는 글자 부분 일치로 넓혀 판정하지 않는다.

### 2.5 변수 치환

- `{{이름}}`, `{{이름|변환|변환}}` — 변환: `trim`, `digits`, `upper`, `lower`, `default:값`.
- 정의 안 된 변수는 빈 문자열로 바꾸지 말고 오류로 행을 실패시킨다(빈 값으로 조회·저장하는 사고 방지). 변수 정의 없이 엑셀 열 이름을 바로 써도 된다.
- 예약 이름: `row`(지금 행 번호), `lastDialogMessage`, 그리고 날짜 토큰:
  - `{{sys:year}}`, `{{sys:month}}`, `{{sys:day}}`, `{{sys:quarter}}`("3분기" 형태), `{{sys:date:형식}}`
  - 뒤에 `:±N` 을 붙이면 이동한다. 형식에 일(D)이 있으면 일 단위, 없고 월(M)이 있으면 월 단위, 아니면 년 단위. quarter 는 분기 단위.
  - 형식 문자: `YYYY` `YY` `MM` `M` `DD` `D` `HH` `mm` `ss`, 나머지 글자(예: "년", "월", "-")는 그대로.
  - 월·년 이동은 말일을 맞춘다(1/31 + 1개월 = 2월 말일).
- 값 읽기(`extract`)로 만든 변수는 행마다 비운다.

### 2.6 실행 결과 (`runDir`)

- `report.json`: `{ runId, recipe: { id, name }, status, error, startedAt, endedAt, durationMs, options, excel, totals: { rows, ok, failed }, rows: [행 결과], files }`
- 행 결과: `{ rowNumber, label, input, status: 'ok'|'failed', values, files(runDir 기준 상대 경로), durationMs, error?, failure?: { stepId, block, index, desc }, screenshot? }`
  - `label` 은 엑셀 앞 두 열 값으로 만든 짧은 이름.
- `rows.csv`(UTF-8 BOM): 행, 입력 열들, 결과(성공/실패), 읽은 값들, 오류. 셀은 CSV 수식 주입을 막는다(`=`, `+`, `-`, `@` 로 시작하는 값).
- `log.txt`, `results.xlsx`(입력 열 + 결과 + 읽은 값 열), `files/`(다운로드·PDF·캡처), `failures/row-N.png`, `video/`(recordVideo 일 때).

---

## 3. 녹화 요구사항

1. 모든 탭·팝업·프레임(중첩 iframe, 열린 shadow DOM 포함)에서 사람이 한 신뢰 이벤트만 기록한다. 스크립트가 일으킨 이벤트는 버린다.
2. `window.open` 으로 연 창도 첫 문서부터 기록해야 한다. 이런 창은 빈 문서에서 같은 출처 주소로 넘어갈 때 window 객체가 재사용되고, 브라우저 자동화 도구의 문서 시작 스크립트가 그 첫 문서에 적용되지 않을 수 있다 — 문서마다 캡처가 설치됐는지 보장한다.
3. 입력은 칸마다 최종값 하나로 기록한다(키 하나하나를 스텝으로 만들지 않는다). 같은 칸에 이어서 입력하면 값만 갱신한다. 비밀번호 칸은 값을 남기지 않고, 실행 때 입력받는 비밀 변수(`prompt`, `secret: true`)로 바꾼다. 같은 이름의 비밀 칸은 같은 변수를 쓴다.
4. 선택 상자는 값과 보이는 글자를 함께 남긴다. 체크박스·라디오는 원하는 상태(`checked`)로 남긴다. 라벨을 눌러 바꾼 경우도 대상은 실제 입력 요소다.
5. Enter·Escape 는 `keypress` 로 남긴다(Enter 로 생긴 암묵적 제출 클릭은 중복 기록하지 않는다).
6. 더블클릭은 하나의 `dblclick` 으로 남긴다(앞선 두 번의 클릭을 합친다).
7. 파일 선택 input 이 바뀌면 `upload` 스텝(경로는 비움, 고른 파일 이름은 meta 에)을 남긴다. 숨은 파일 input 을 버튼으로 여는 사이트도 같다.
8. 다운로드가 시작되면 그 원인이 된 최근 클릭을 `download` 스텝으로 바꾼다. 새 창에서 시작된 다운로드, 서버가 파일을 만드느라 늦게(수 초 이상) 시작된 다운로드도 포함한다. 원인을 못 찾으면 `warn` 을 낸다.
9. 알림창(alert/confirm/prompt)은 `dialog` 스텝으로 남기고, 재생 때 미리 방침을 걸 수 있게 원인 동작 **앞**에 넣는다(`meta.triggerStepId`). 사용자의 응답(확인/취소, 입력 글자)을 기록한다. 녹화 중 대화상자는 사람이 직접 응답한다.
10. 사이트의 인쇄 호출은 녹화 중 실제 인쇄창을 띄우지 않고 원인 동작 뒤에 `pdf` 스텝으로 남긴다.
11. 사이트가 연 팝업이 닫히면 `closeTab` 을 남긴다(창이 닫히며 마지막 클릭이 유실될 수 있으므로).
12. 타겟 번들: 한 요소에 여러 후보 선택자를 점수와 함께 만든다. 녹화 시점에 그 요소 하나만 가리키는 후보를 우선한다.
    - 매 접속마다 바뀌는 id(긴 숫자 덩어리, 무작위 해시, UUID 등)를 그대로 쓴 후보는 믿을 만한 후보보다 뒤에 둔다. 바뀌지 않는 앞·뒤 부분으로 찾는 후보 등 대안을 함께 만든다.
    - 사람이 읽는 이름(라벨, aria, 보이는 글자)을 `meta` 에 남긴다.
    - 같은 함수를 AI 관찰기가 쓸 수 있게 페이지 안에 노출한다.

## 4. 실행 요구사항

### 4.1 흐름

1. 엑셀(xlsx·csv)을 모두 문자열로 읽는다(앞자리 0 보존). 레시피가 쓰는 엑셀 열이 없으면 시작 전에 알아듣기 쉬운 오류. 엑셀이 없으면 한 번 실행.
2. 행마다: 업무 탭 하나만 남기고 나머지 탭을 닫은 뒤 시작 블록을 실행한다. 행 실패는 오류·실패 스텝·화면 캡처를 기록하고 다음 행으로 간다(`onRowError: 'stop'` 이면 멈춤).
3. `branch` 는 조건에 따라 `then`/`else` 블록을 실행하고 다음 스텝으로 돌아온다(호출형). 알림 문구로 분기할 때는 늦게 뜨는 알림을 잠깐 기다린다.
4. 무한 반복·과도한 중첩을 막는 상한을 둔다.
5. `humanPacing` 이면 화면 조작 스텝 앞에 녹화 당시 간격만큼(상한 있음) 쉰다.
6. 재생 중 사이트의 `window.print()` 는 막는다(인쇄창이 페이지를 멈추게 하므로). 출력은 `pdf` 스텝이 맡는다.

### 4.2 요소 찾기

- 후보를 점수 높은 순으로 시도해 **정확히 하나**만 맞는 후보를 쓴다(0개·여러 개면 다음 후보). 보이는 요소를 우선하고, 숨은 요소는 잠시 기다려도 보이는 것이 없을 때 쓴다.
- 프레임 경로를 이름 → 주소 → 순번으로 따라간다. 경로가 깨졌으면 모든 프레임에서 합계로 유일성을 본다.
- 녹화 후보 말고도 실행 때 추가 후보를 만들 수 있다(예: 바뀌는 id 의 안정된 부분, 라벨로 만든 속성 선택자).
- 대상이 나타날 때까지 기다린다. 기본 대기, `optional` 일 때의 짧은 대기, `timeoutMs` 지정을 지원한다.
- 못 찾으면 시도한 후보와 맞은 개수를 담은 오류를 낸다.

### 4.3 탭

- 사이트가 연 창(opener 가 있는 창)이 열리면 그 창으로 옮긴다. 브라우저가 스스로 만든 빈 탭(다운로드 뒤 등)은 무시한다.
- 창이 닫히면 직전 탭으로 돌아온다. 업무 탭은 `closeTab` 으로도 닫지 않는다.
- 스텝 대상이 지금 탭에 없고, 녹화 당시 주소(`meta.url`)와 같은 다른 탭에 유일하게 보이면 그 탭으로 옮긴다. 못 찾았을 때 대상이 보이는 다른 탭이 있으면 옮겨 다시 시도한다.

### 4.4 동작

- **부작용을 두 번 내지 않는다**: 클릭 이벤트가 이미 나갔을 수 있는 실패는 다시 누르지 않는다. 다운로드·PDF·첨부는 재시도하지 않는다. 요소를 못 찾아 아직 아무것도 하지 않은 경우만 화면이 다 그려질 때까지 다시 찾는다.
- **클릭**: 가려졌거나 숨은 요소는 스크립트 클릭으로 대신하되, 화면·주소·탭·대화상자 중 하나라도 바뀌었는지 확인하고 아무 변화가 없으면 실패로 본다. 누른 결과 그 창이 닫혔으면(팝업의 "선택"·"닫기") 성공이다. 클릭으로 새 창이 열리면 그 창으로 옮긴다.
- **입력**: 값을 넣은 뒤 반영됐는지 확인한다. 자동 하이픈 같은 마스크 칸은 숫자만 같으면 된 것으로 보고, 반영이 안 되면 실제 키 입력으로 다시 넣는다. contenteditable 도 지원.
- **선택**: 값 → 라벨 → 띄어쓰기 무시 비교 순으로 옵션을 찾는다(엑셀의 "1기(예정+확정)" 과 화면의 "1기 (예정+확정)").
- **체크**: 이미 원하는 상태면 누르지 않는다. 화면에 거의 안 보이는 커스텀 체크박스는 연결된 라벨을 누르는 방식까지 시도한 뒤 결과 상태를 확인한다.
- **키 입력**: 대상이 있으면 그 요소에서, 없으면 페이지에서. 누른 결과 창이 닫히면 성공.
- **값 읽기**: 입력 요소는 값, 나머지는 보이는 글자(공백 정리). `attr` 이면 속성 값. 읽은 값은 변수와 리포트 값에 들어간다.
- **대화상자**: `dialog` 스텝은 다음 대화상자의 방침을 차례 대기열에 넣는다. 방침이 없는 대화상자는 알림은 확인, 확인창·입력창은 취소(예상 못 한 동작을 승인하지 않는다). 모든 대화상자 문구를 `lastDialogMessage` 로 남긴다.
- **다운로드**: 어느 탭에서 시작되든(새 창·새 탭 포함, 늦게 시작돼도) 첫 다운로드를 받아 끝날 때까지 기다린다. 이름은 `fileName` 규칙(변수 치환, 확장자는 원래 것) 또는 사이트가 준 이름. 같은 이름이 있으면 덮어쓰지 않고 ` (1)` 식으로 번호를 붙인다(동시에 같은 이름을 잡지 않게). 빈 파일·실패한 다운로드는 오류.
- **PDF**: 숨김 실행이면 인쇄용 PDF(A4, 배경 포함), 화면 표시 실행이면 전체 화면 캡처를 A4 쪽으로 나눈 PDF. 저장 뒤 정상 PDF 인지 확인한다.
- **화면 캡처**: 기본 전체 페이지.
- **파일 첨부**: 파일이 있는지 먼저 확인. 대상이 파일 input 이면 바로 넣고, 아니면 눌러서 뜨는 파일 선택창에 넣는다.
- **팝업 창 닫기**: 지금 팝업을 닫는다. 이미 닫혔으면 건너뛰었다고 로그만.
- **사용자 확인 대기**: 상태를 `waiting-user` 로 바꾸고 `resume()` 을 기다린다.
- **파일 이름 정리**(`safeFileName`): Windows 금지 문자 치환, 끝의 점·공백 제거, 예약 이름(CON, NUL 등) 회피, 너무 긴 이름 자르기(확장자 유지), 비면 오류.

### 4.5 스텝 공통

- `disabled` 는 건너뛴다. `attempts` 만큼 재시도(되돌릴 수 없는 스텝 제외). `optional` 이고 대상이 없거나 조건 대기가 시간 초과면 건너뛴다. `onError: "continue"` 면 경고만 남기고 계속.
- `assert` 실패는 행 실패. `onFail: "warn"` 이면 경고만.

## 5. 레시피 도우미 (`src/recipe.js`)

- `referencedNames(recipe)`: 블록과 static 변수 값에서 `{{이름}}` 을 모은다(변환 부분 제외).
- `excelColumnsOf(recipe)`: 실제로 참조되는 excel 변수의 열만(정의만 남은 변수 제외).
- `promptVariablesOf(recipe)`: 실행 전에 물어야 하는 prompt 변수.
- `recipeProblems(recipe)` → 문제 문장 배열: 이름·블록·시작 블록 존재, 스텝 id 중복, 알 수 없는 종류, 대상이 필요한 스텝의 대상 누락, 이동 주소, 값 읽기 변수 이름, 분기 조건과 대상 블록, 대기·확인 조건, 정의 안 된 변수(예약 이름·값 읽기 변수 제외).
- `autoLinkExcel(recipe, headers, firstRow)` → `{ recipe(사본), linked: [{ stepId, column }] }`: 엑셀 첫 행 값과 똑같은 입력·선택 값을 `{{열}}` 로 바꾼다. 한 열에서만 일치할 때만. 원래 값은 `meta.recordedValue` 에 남기고, 필요한 excel 변수를 만든다.
- `ensureExcelVariable(recipe, column)`.

## 6. 진행 세트(.wrset)·허브 (0.2.0)

| 파일 | 내보내는 것 |
|---|---|
| `src/set/core.mjs`, `src/set/zip.mjs` | 세트 규칙(정리·위험·개인정보·manifest·세트 검사·기대 결과 비교)과 결정적 zip. **허브 저장소 CI 와 같은 파일** — 함수 이름·인자를 바꾸지 않는다 |
| `src/set/folder.mjs` | `readSetDir`, `packFiles`, `packSetDir`, `unpackSet` (의존성 없음, 허브 CI 도 쓸 수 있다) |
| `src/set/index.js` | `ENGINE_VERSION`(package.json), `setDraft`, `buildSet`, `readSet`, `inspectSet`/`inspectFiles`, `publicPreview`, `installSet`, `installedSets`, `riskSummary`, `expectedDraft` |
| `src/set/hub.js` | `checkHubUrl`, `normalizeIndex`, `fetchIndex`, `hubList`, `resolveHubSet`, `downloadHubSet`, `hubReadme` |
| `src/engine/sites.js` | `guardSites(ctx, origins, onBlock)`, `normOrigin`, `siteAllowed` |
| `src/cli.js` | 명령줄 (`set lint/pack/unpack/test/install`, `hub list/install`) |

- 세트 파일 목록·manifest 형식은 `core.mjs` 의 `lintSet`·`manifestProblems` 가 기준이다. 크기 2MB 이하.
- 허브 목록(`index.json`): `{ format: "web-rpa-hub-index", formatVersion: 1, generatedAt, hub: { name, url, repo }, sets: [{ id, name, summary, author, license, tags, latest, versions: [{ version, engine, url, sha256, size, publishedAt, risk, sites, columns, verified: { at, result } }], readme }] }`. `url`·`readme` 는 목록 주소 기준 상대 경로. 허브 주소는 https 만(이 PC 안의 시험 주소만 http).
- 허브 설치 순서: 목록의 `engine` 범위 확인 → 내려받기 → 목록의 sha256 과 대조(다르면 설치하지 않음) → 세트 검사(manifest 의 엔진 범위·id·버전 포함) → 미리보기 → 설치.
- 설치: 레시피에 `origin = { set, version, sha256, source, installedAt, sites, pacing }` 을 넣어 저장하고, `input/sample.csv` 를 올린 파일로, 원본 .wrset 을 `sets/packages/` 에, 설치 기록을 `sets/installed.json` 에 남긴다. 같은 세트는 같은 레시피를 바꾼다.
- 실행기: `recipe.origin.sites` 가 있으면 업무 탭·팝업이 그 밖의 사이트로 이동하지 못하게 막고 그 행을 알아듣기 쉬운 문구로 실패시킨다(하위 자원·iframe·about:·data:·blob: 허용). `pacing.minRowIntervalMs` 만큼 행 사이를 쉬고, `pacing.maxRowsPerRun` 을 넘는 행은 실행하지 않고 멈춘다(`report.limit`, 상태 `stopped`). `origin` 이 없는 레시피는 전과 같다.
- API: `GET /api/recipes/:id/set-draft`, `POST /api/recipes/:id/set`(`check: true` 면 검사 결과만), `POST /api/sets/preview`·`/api/sets/install`(본문 = .wrset), `GET /api/sets/installed`, `GET /api/hub[?refresh=1]`, `GET /api/hub/readme?source=&id=`, `POST /api/hub/preview`·`/api/hub/install`(`{ source, id, version? }` — source 는 설정에 있는 허브만).

## 7. 합격 기준

모두 통과해야 한다(Windows, Edge 설치됨):

```
node test/e2e.mjs
node test/agent-mock.mjs     (e2e 다음에)
node test/gui-smoke.mjs      (e2e 다음에)
node test/settings-check.mjs
node test/lab.mjs            (숨김, 106개 검사)
node test/lab.mjs --headed   (화면 표시 — PC 화면에 Edge 창이 뜬다)
node test/headed-check.mjs
node test/set-check.mjs      (진행 세트·허브)
```

시험 코드는 동작을 확인하는 기준이므로 고치지 않는다. 시험이 틀렸다고 판단되면 고치지 말고 이유를 보고한다.
