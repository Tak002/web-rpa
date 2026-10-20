; web-rpa 설치 파일 (Inno Setup 6). 직접 부르지 말고 node scripts/package-win.mjs --installer 로 만든다.
;   관리자 권한 없이 %LOCALAPPDATA%\Programs\web-rpa 에 설치한다. 작업 데이터(%LOCALAPPDATA%\web-rpa)는 지우지 않는다.
;   이 파일은 UTF-8 BOM 으로 저장해야 한국어 문구가 깨지지 않는다.

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Stage
  #error Stage 폴더를 /DStage=... 로 넘겨 주세요
#endif
#ifndef OutDir
  #define OutDir "."
#endif

[Setup]
AppId={{6E3B8C2A-41F7-4D5B-9A0E-2F5D9E7A1C30}
AppName=web-rpa
AppVersion={#Version}
AppVerName=web-rpa {#Version}
AppPublisher=Tak002
AppPublisherURL=https://github.com/Tak002/web-rpa
DefaultDirName={localappdata}\Programs\web-rpa
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=web-rpa-setup-{#Version}
SetupIconFile={#Stage}\web-rpa.ico
UninstallDisplayIcon={app}\web-rpa.ico
UninstallDisplayName=web-rpa
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile={#Stage}\app\LICENSE
CloseApplications=yes

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 바로가기 만들기"; GroupDescription: "바로가기:"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\web-rpa"; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\src\launch.js"""; WorkingDir: "{app}\app"; IconFilename: "{app}\web-rpa.ico"; Comment: "웹 작업 녹화 · 엑셀 반복 실행"
Name: "{autodesktop}\web-rpa"; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\src\launch.js"""; WorkingDir: "{app}\app"; IconFilename: "{app}\web-rpa.ico"; Comment: "웹 작업 녹화 · 엑셀 반복 실행"; Tasks: desktopicon

[Run]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\src\launch.js"""; WorkingDir: "{app}\app"; Description: "web-rpa 실행"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
