# web-rpa

웹에서 하는 반복 작업을 한 번 녹화해 "레시피"로 만들고, 엑셀 행마다 같은 작업을 자동으로 반복하는 Windows용 로컬 RPA 도구입니다.
조회·입력·다운로드·PDF 저장·화면 캡처·값 읽기를 행마다 하고, 결과를 엑셀과 리포트로 남깁니다.

- 녹화: 평소처럼 브라우저에서 작업하면 클릭·입력·선택·다운로드·파일 첨부·알림창 응답이 스텝으로 기록됩니다. 팝업 창과 iframe 안의 동작도 기록합니다.
- 반복: 입력값을 엑셀 열로 바꾸면 엑셀 행마다 실행합니다. 실패한 행은 화면을 남기고 다음 행으로 넘어갑니다.
- 결과: 행별 성공/실패, 읽은 값, 받은 파일, 실패 화면, 결과 엑셀, 실행 기록, (선택) 실행 화면 영상.
- 브라우저: PC에 설치된 Edge·Chrome·Brave(또는 Playwright Chromium)를 씁니다. 모든 처리는 이 PC 안에서 합니다.

## 설치와 실행

필요한 것: Windows 10/11 (64비트), Edge 또는 Chrome. Node.js 는 설치 파일에 들어 있습니다.

- **설치 파일** `web-rpa-setup-<버전>.exe` — 관리자 권한 없이 `%LOCALAPPDATA%\Programs\web-rpa` 에 설치하고 시작 메뉴(선택하면 바탕화면)에 바로가기를 만듭니다. 바로가기를 누르면 화면이 브라우저에 열리고, 함께 뜨는 검은 창을 닫으면 멈춥니다. 이미 실행 중이면 화면만 엽니다. 제거는 Windows 설정 → 앱에서 합니다.
- **압축본** `web-rpa-<버전>-win-x64.zip` — 원하는 폴더에 풀고 `web-rpa.cmd` 를 실행합니다.
- 두 방식 모두 작업 데이터(레시피·실행 결과·브라우저 프로필·설정)는 `%LOCALAPPDATA%\web-rpa` 에 저장되고, 다시 설치하거나 제거해도 남습니다.
- 설치 파일은 코드 서명이 되어 있지 않아 처음 실행할 때 "Windows의 PC 보호" 창이 뜰 수 있습니다. "추가 정보 → 실행"을 누르면 설치됩니다.

소스에서 실행하려면 [Node.js](https://nodejs.org/) 20 이상을 설치하고 `start.cmd` 를 실행합니다(처음에 의존성을 설치하고 http://127.0.0.1:4800 을 엽니다. 작업 데이터는 `workspace\`).
설치 파일 만들기: [Inno Setup 6](https://jrsoftware.org/isinfo.php) 을 설치한 뒤 `node scripts\package-win.mjs --installer --smoke` (결과 `dist\`, 만든 파일을 실제로 설치·실행·제거해 확인합니다).

- **브라우저**는 화면의 **설정**에서 고릅니다: 자동(Edge → Chrome → Brave → 내장 Chromium), Edge, Chrome, Brave, 내장 Chromium, 직접 지정(Chromium 계열 실행 파일). 설치 여부는 자동으로 감지하고 "시험 실행"으로 버전을 확인할 수 있습니다.
- **프로필**은 브라우저마다 따로 둡니다(`workspace\profiles\<브라우저>`). 녹화·실행·AI 관찰이 같은 프로필을 쓰므로 녹화 브라우저에서 로그인해 두면 실행 때도 유지됩니다(사이트가 세션을 유지하는 동안).
- 녹화·실행 브라우저는 서버가 도는 PC 화면에 뜹니다. 서버를 서비스(세션 0)로 띄우면 브라우저 창이 보이지 않으니, 로그인한 사용자 세션에서 실행하세요(`run-server.cmd`).

## 쓰는 순서

1. **녹화** — 이름과 시작 주소를 넣고 녹화를 시작합니다. 열린 브라우저에서 평소처럼 작업한 뒤 "녹화 종료하고 저장".
2. **편집** — 입력값을 엑셀 열로 바꿉니다("엑셀 열로 바꾸기" 또는 "엑셀 첫 행으로 자동 연결"). 필요하면 값 읽기·대기·PDF 저장 스텝을 더합니다.
3. **실행** — 엑셀(xlsx·csv)을 넣고 실행합니다.
4. **리포트** — 행별 결과, 읽은 값, 저장 파일, 실패 화면, 결과 엑셀(`results.xlsx`), 실행 기록.

## AI 도우미 (선택, OpenRouter)

편집기의 **✦ AI 도우미** 패널에서 레시피를 대화로 고칩니다. 예: "입력값들을 엑셀 열로 바꿔 줘", "조회 결과 화면에서 금액을 읽어서 결과 엑셀에 남겨 줘".

- OpenRouter 키와 모델을 패널의 [설정]에서 넣습니다(`workspace\settings.json`, 화면에는 끝 4자리만). 환경 변수 `OPENROUTER_API_KEY` 도 됩니다.
- 필요하면 숨긴 브라우저로 레시피를 특정 스텝까지 실행해 화면 요소 목록을 보고, 참조 번호로 새 요소를 지정합니다. 출력 스텝(PDF·다운로드·첨부)은 건너뛰고, "제출·신고·결제·삭제·발송"류 버튼은 허용하지 않으면 누르지 않습니다.
- AI 의 변경은 사본에만 합니다. 변경 목록을 보고 [적용]해야 편집기에 반영되고, [저장]해야 파일에 남습니다.
- **데이터 전송 고지**: AI 도우미를 쓰면 레시피 내용(녹화된 입력값 포함)과 관찰한 화면 요소 목록이 OpenRouter 와 선택한 모델 제공사로 전송됩니다. 개인정보·고객 정보가 담긴 레시피에는 쓰지 마세요. AI 도우미를 쓰지 않으면 외부로 아무것도 보내지 않습니다.

## 레시피 형식 (요약)

```jsonc
{
  "schemaVersion": 1, "id": "…", "name": "…", "startUrl": "https://…",
  "variables": [{ "id": "상호", "name": "상호", "source": { "kind": "excel", "column": "상호" } }],
  "entryBlock": "main",
  "blocks": { "main": [ { "id": "s1", "type": "navigate", "url": "…" }, { "id": "s2", "type": "input", "target": { … }, "value": "{{상호}}" } ] },
  "loop": { "onRowError": "skip" }
}
```

- 스텝 종류: `navigate` `click` `dblclick` `input` `select` `check` `keypress` `wait` `sleep` `extract` `assert` `branch` `dialog` `pdf` `screenshot` `download` `upload` `pause` `closeTab`
- 스텝 공통 필드: `optional`(대상이 없으면 건너뜀), `onError: "continue"`, `attempts`(총 시도 횟수), `timeoutMs`, `disabled`
- 조건(`wait`·`assert`·`branch`): `exists` · `textVisible` · `urlContains` · `varEquals` · `dialogContains` · `not` · `all` · `any`
- `branch` 는 `then`/`else` 블록을 실행한 뒤 다음 스텝으로 돌아옵니다.
- 변수 종류: `excel` · `static` · `prompt`(실행 때 입력, `secret: true` 면 화면에 가림)
- 내장 토큰: `{{row}}`, `{{sys:date:YYYYMMDD}}`, `{{sys:month:-1}}`, `{{sys:quarter}}`, `{{lastDialogMessage}}`. 변환: `{{값|digits}}`, `|trim`, `|upper`, `|lower`, `|default:x`

자세한 동작은 [docs/requirements.md](docs/requirements.md), 구현 방식은 [docs/design-notes.md](docs/design-notes.md) 를 보세요.

## 시험

```cmd
node test\compat.mjs         :: 이전 버전과 같은 결과인지 (날짜 토큰·변수 치환·파일 이름·레시피 검사·엑셀 읽기, 브라우저 없음)
node test\e2e.mjs            :: 녹화 → 엑셀 연결 → 3행 재생 → 리포트 (숨김 브라우저)
node test\gui-smoke.mjs      :: 서버·화면 점검 (e2e 다음에)
node test\agent-mock.mjs     :: AI 도우미 (가짜 OpenRouter, e2e 다음에)
node test\settings-check.mjs :: 브라우저 감지·선택·전용 프로필
node test\headed-check.mjs   :: 화면 표시 모드 녹화·실행 (PC 화면에 브라우저 창이 잠깐 뜸)
node test\lab.mjs [--headed] [--only=A,B,C] :: 종합 시험: 녹화→재생, 다운로드 9종·팝업·첨부·대화상자·iframe, 월별 목록 고르기 (결과 test\out-lab\)
node test\lab-server.mjs 4811 :: 시험 사이트를 띄워 직접 녹화해 보기 (tester / lab-pass-123)
```

실행 화면 영상: 실행 화면에서 "실행 화면을 동영상으로 남기기"를 켜면(API 는 `options.recordVideo: true`) 탭마다 webm 이 `runs\<실행>\video\` 에 남고 리포트 화면에서 재생됩니다.

공개 전 점검: `node scripts\check-release.mjs`(비밀값·개인 경로 검사), `node scripts\notices.mjs --check`(제3자 고지 갱신), `node scripts\package-win.mjs --installer --smoke`(Node 를 함께 담은 설치 파일·zip 을 만들고 실제로 설치·실행·제거해 확인).

## 알려진 제한

- 화면 표시 모드의 PDF 저장은 전체 화면 캡처를 A4 로 나눈 이미지 PDF 입니다(글자 선택 불가). 숨김 실행이면 인쇄용 PDF 로 저장됩니다.
- 사이트의 `window.print()` 는 재생 중 막습니다. 출력은 PDF 스텝이 맡고, 실제 프린터 출력은 없습니다.
- 녹화 중 주소창에 직접 친 이동은 자동 기록되지 않습니다. "현재 주소로 이동" 버튼으로 넣습니다.
- 파일 첨부는 녹화되지만 첨부할 파일 경로는 편집에서 지정해야 합니다.
- 공동인증서·간편인증 같은 로그인은 자동화하지 않습니다. 녹화 브라우저에서 직접 로그인해 두거나 "사용자 확인 대기" 스텝으로 사람이 처리합니다.
- 목록의 행마다 반복하기, 지난번에 처리한 항목 건너뛰기는 아직 없습니다. 처리할 항목을 엑셀 행으로 나열하세요.
- 인증이 없는 로컬 도구입니다. 서버는 127.0.0.1 에만 열립니다. 다른 기기에서 쓰려면 VPN 등 신뢰할 수 있는 사설망 안에서만 여세요.

## 책임 있는 사용

- 자동화하려는 사이트의 이용약관과 자동 접속 정책을 지키는 것은 사용자의 책임입니다. 과도한 반복 요청으로 서비스에 부담을 주지 마세요.
- 다른 사람 명의의 계정·인증서로 로그인하거나, 권한 없는 정보에 접근하는 데 쓰지 마세요.
- 실행 결과(`workspace\runs`)와 브라우저 프로필(`workspace\profiles`)에는 화면 내용과 로그인 쿠키가 남습니다. 공유하거나 저장소에 올리지 마세요.

## 라이선스

[MIT](LICENSE). 사용한 오픈소스의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 에 있습니다.
