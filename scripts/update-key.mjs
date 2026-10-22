// 업데이트 서명 키 (Ed25519): 개인 키는 저장소 밖에 두고, 공개 키는 src/update.js 의 PUBLIC_KEYS 에 넣는다.
// 실행: node scripts/update-key.mjs            개인 키가 없으면 만들고(있으면 그대로) 공개 키·지문을 출력
//       node scripts/update-key.mjs --public   공개 키(base64 SPKI DER)만 출력
//       node scripts/update-key.mjs --check    개인 키와 앱 속 공개 키가 짝인지: "공개 키 일치: 예|아니오" (아니면 종료 코드 1)
// 개인 키 위치: %USERPROFILE%\.web-rpa-signing\update-ed25519.pem (WEB_RPA_SIGNING_KEY 로 바꿈)
//   잃으면 지금 설치본들이 새 버전을 자동으로 받지 못한다 — 안전한 곳(암호를 건 USB·암호 관리자 등)에 따로 백업해 두세요.
//   저장소·dist·작업 폴더·로그에 두지 마세요 (scripts/check-release.mjs 가 저장소 안의 키 파일을 찾으면 실패한다).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PUBLIC_KEYS, publicKeyOf, keyFingerprint } from '../src/update.js';

export const signingKeyPath = () => process.env.WEB_RPA_SIGNING_KEY || path.join(os.homedir(), '.web-rpa-signing', 'update-ed25519.pem');

/** 개인 키 읽기 (없으면 null). Ed25519 가 아니면 throw. */
export function loadSigningKey(file = signingKeyPath()) {
  if (!fs.existsSync(file)) return null;
  const key = crypto.createPrivateKey(fs.readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} 은(는) Ed25519 개인 키가 아닙니다 (${key.asymmetricKeyType}).`);
  return key;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  const file = signingKeyPath();
  const root = path.resolve(import.meta.dirname, '..');
  if (path.resolve(file).toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
    console.error(`개인 키를 저장소 안(${file})에 둘 수 없습니다. WEB_RPA_SIGNING_KEY 를 저장소 밖 경로로 바꿔 주세요.`);
    process.exit(1);
  }
  let key = loadSigningKey(file);

  if (args.includes('--check')) {
    if (!key) {
      console.log(`개인 키가 없습니다: ${file}`);
      console.log('공개 키 일치: 아니오');
      process.exit(1);
    }
    const pub = publicKeyOf(key);
    const ok = PUBLIC_KEYS.includes(pub);
    console.log(`개인 키: ${file}`);
    console.log(`공개 키 지문: ${keyFingerprint(pub)}`);
    console.log(`앱 속 공개 키: ${PUBLIC_KEYS.length}개 (${PUBLIC_KEYS.map((k) => keyFingerprint(k).slice(0, 16)).join(', ') || '없음'})`);
    console.log(`공개 키 일치: ${ok ? '예' : '아니오'}`);
    process.exit(ok ? 0 : 1);
  }

  let created = false;
  if (!key) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' }); // 있으면 덮어쓰지 않는다
    key = loadSigningKey(file);
    created = true;
  }
  const pub = publicKeyOf(key);
  if (args.includes('--public')) {
    console.log(pub);
    process.exit(0);
  }
  console.log(created ? `개인 키를 만들었습니다: ${file}` : `개인 키가 이미 있습니다 (그대로 씁니다): ${file}`);
  console.log(`공개 키 (src/update.js 의 PUBLIC_KEYS 에 넣기): ${pub}`);
  console.log(`공개 키 지문: ${keyFingerprint(pub)}`);
  console.log(`앱 속 공개 키와 ${PUBLIC_KEYS.includes(pub) ? '일치합니다' : '아직 다릅니다 — PUBLIC_KEYS 에 넣어 주세요'}.`);
  if (created) console.log('개인 키를 잃으면 지금 설치본이 새 버전을 자동으로 받지 못합니다. 저장소 밖 안전한 곳에 백업해 두세요.');
}
