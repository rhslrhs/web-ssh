# Web SSH

PC·모바일 **브라우저만으로** 쓰는 셀프호스팅 SSH 클라이언트입니다. 시놀로지 NAS 같은 상시 구동 장비에 Docker 로 띄워 두고, 집 안의 NAS·PC·VM·서버에 접속합니다.

회사 PC 등에 VPN 클라이언트를 설치할 수 없을 때를 위한 **웹 게이트웨이**로도 쓸 수 있습니다 (HTTPS + 2단계 인증).

```
[폰/PC 브라우저] ──(LAN · VPN · HTTPS 리버스 프록시)──▶ web-ssh (NAS, Docker)
                                                         ├─▶ NAS 자신
                                                         ├─▶ Windows PC (OpenSSH Server)
                                                         ├─▶ Hyper-V / Proxmox VM
                                                         └─▶ 외부 리눅스 서버
```

## 기능
- **터미널**: xterm.js, 256색, 한글, 창 크기 자동 맞춤
- **모바일**: 특수키 바(Esc / Tab / Ctrl·Alt 고정 / ↵ / 방향키 반복 / ^B ^C ^D / F1~F10), 손가락 드래그 스크롤, 한글이 깨지지 않는 입력창, 홈 화면에 추가(PWA)
- **호스트 관리**: 그룹, 인증 방식(매번 입력 / 비밀번호 저장 / 개인키), 저장값은 AES-256-GCM 암호화(호스트별로 묶음) — 브라우저로 절대 전송 안 됨
- **호스트 키 검증 (TOFU)**: 첫 접속 시 지문 확인, 이후 바뀌면 접속 차단
- **점프 호스트**: 내부 NAT 뒤 VM 등을 다른 호스트 경유로 접속
- **접속 후 실행 명령**: 예) WSL + tmux + Claude Code 를 한 번에 ([아래](#wsl-에서-claude-code-쓰기))
- **PC 켜기 (Wake-on-LAN)**: 켜기 신호 → 부팅 대기 → 자동 접속. 앱 아이콘을 길게 누르면 "PC 켜기" 바로가기
- **푸시 알림 (PWA)**: Claude Code 작업 완료·입력 대기를 폰으로 — 누르면 해당 터미널로. 연동은 명령 한 줄
- **로그인**: 앱 비밀번호 + **TOTP 2단계 인증**, **패스키(지문·Face ID)**, 30분 무활동 시 로그아웃(쓰는 동안 자동 연장)
- **보안**: 외부 접속은 OTP 필수, 허용 IP 목록, 로그인 시도 제한, 전체 로그아웃, Origin 검사

## 빠른 시작 (Docker)
```bash
git clone https://github.com/rhslrhs/web-ssh.git
cd web-ssh
./gen-env.sh                  # .env 생성 (무작위 비밀번호·암호화 키, WOL 주소 감지, 데이터 폴더 생성)
docker compose up -d --build  # 구버전: docker-compose up -d --build
```
`http://<서버 IP>:8822` 접속 → 앱 비밀번호로 로그인 → **+ 호스트**.

`gen-env.sh` 옵션
```bash
./gen-env.sh --password '내비밀번호'                       # 비밀번호 직접 지정 (생략 시 입력받거나 자동 생성)
./gen-env.sh --domain ssh.example.synology.me --allow 203.0.113.7   # 외부 접속(웹 게이트웨이) 설정 포함
./gen-env.sh -f                                           # 기존 .env 백업 후 다시 생성 (SECRET_KEY 도 바뀜!)
```
수동으로 하려면 `.env.example` 을 `.env` 로 복사해 수정하고 `mkdir -p ../web-ssh-data`.

> 컨테이너는 `network_mode: host` 로 동작합니다 (WOL 브로드캐스트와 내부망 접근용).

### 시놀로지 Container Manager
1. 이 폴더를 `/volume1/docker/web-ssh` 에 복사 → SSH 로 `cd /volume1/docker/web-ssh && sh gen-env.sh`
2. Container Manager → 프로젝트 → 생성 → 경로 지정 → 기존 `docker-compose.yml` 사용

### 로컬 실행 (개발)
```bash
npm install
APP_PASSWORD=testpassword123 node server.js   # http://localhost:8822
npm test                                       # 엔드투엔드 스모크 테스트
```

## 환경 변수 (`.env`)
| 이름 | 기본값 | 설명 |
|---|---|---|
| `APP_PASSWORD` | (필수) | 웹 로그인 비밀번호, 8자 이상 |
| `SECRET_KEY` | 자동 생성 | 저장 비밀번호 암호화 키. 바꾸면 저장된 비밀번호를 다시 입력해야 함 |
| `PORT` | `8822` | 웹 포트 |
| `WOL_BROADCAST` | `255.255.255.255` | WOL 브로드캐스트 주소 (예: `192.168.0.255`) |
| `SESSION_IDLE_MIN` | `30` | 이 시간(분) 동안 활동이 없으면 로그아웃. 쓰는 동안 자동 연장 |
| `SESSION_MAX_HOURS` | `168` | 계속 써도 이 시간이 지나면 다시 로그인 (7일) |
| `TRUST_PROXY` | `0` | 같은 장비의 리버스 프록시 뒤에 둘 때 `1` (`X-Real-IP` 사용) |
| `PUBLIC_ACCESS` | `0` | 외부(공인 IP) 접속 허용. `0` 이면 LAN/VPN 외 전부 403 |
| `ALLOW_PUBLIC_IPS` | (전체) | 외부 허용 IP/대역, 예: `203.0.113.7,198.51.100.0/24` |
| `PUBLIC_ORIGIN` | | 외부 주소, 예: `https://ssh.example.synology.me` |
| `TRUST_CGNAT` | `0` | `1` 이면 100.64.0.0/10 을 내부망으로 취급 (Tailscale 사용 시). ISP 가 CGNAT 을 쓰면 같은 ISP 가입자도 이 대역이므로 기본은 외부 취급 |
| `PUSH_SUBJECT` | `PUBLIC_ORIGIN` | Web Push VAPID 연락처 (https URL 또는 mailto:) |
| `SSH_TIMEOUT_MS` | `20000` | SSH 서버 응답 대기 시간. 지문 확인·OTP 입력 등 사용자를 기다리는 동안은 멈춤 (입력 대기는 최대 5분) |
| `PASSKEY_ORIGINS` | | 패스키를 허용할 주소 추가 (쉼표 구분). 기본은 `PUBLIC_ORIGIN` 과 localhost |

데이터는 `../web-ssh-data` 에 저장됩니다. `.env` 와 함께 백업하세요.
`hosts.json`(호스트·암호화된 인증정보) · `auth.json`(OTP) · `passkeys.json` · `push.json`(푸시 구독·VAPID 키) · `notify-token.json`(알림 토큰 해시) · `secret.key`(SECRET_KEY 미지정 시)

## 외부에서 접속하기 (웹 게이트웨이)
VPN 클라이언트를 설치할 수 없는 PC(예: 회사 PC)에서 브라우저로 접속하는 방법입니다.

> ⚠ 이 앱에 로그인하면 등록된 모든 서버에 접속할 수 있습니다. **반드시 2단계 인증을 먼저 설정**하세요. 앱은 OTP 가 설정되지 않으면 외부 로그인을 거부합니다.
> 회사 PC 에서 개인 서버에 접속하는 것이 회사 보안 정책에 맞는지도 확인하세요.

1. **내부망/VPN 에서** 로그인 → 상단 **⚙ 설정** → 2단계 인증 설정 (Google/Microsoft Authenticator 등)
2. `.env` 에 추가 후 재시작
   ```
   TRUST_PROXY=1
   PUBLIC_ACCESS=1
   PUBLIC_ORIGIN=https://ssh.example.synology.me
   # ALLOW_PUBLIC_IPS=회사 공인 IP   (권장)
   ```
3. **DSM 리버스 프록시**: 제어판 → 로그인 포털 → 고급 → 역방향 프록시 → 생성
   - 소스: `HTTPS`, 호스트 이름 `ssh.example.synology.me`, 포트 `443`, HSTS 사용
   - 대상: `HTTP`, `localhost`, `8822` ← 반드시 **localhost** (프록시 헤더 신뢰 조건)
   - 사용자 지정 머리글 → 생성 → **WebSocket** (터미널 연결에 필요)
4. 인증서: 제어판 → 보안 → 인증서에서 해당 호스트 이름을 포함하는 인증서(Let's Encrypt) 지정
5. 공유기: 443 → NAS 포트포워딩 (이미 다른 서비스로 열려 있으면 생략). `8822` 는 **열지 마세요**.

보안 설계 메모
- 외부 로그인은 비밀번호 + OTP 를 함께 검증하고, 어느 쪽이 틀렸는지 알려주지 않습니다. 같은 OTP 코드 재사용 불가.
- IP 당 5회 실패 시 5분 잠금 (마지막 실패 후 15분이 지나면 횟수 초기화), 외부 전체 30회/15분 실패 시 외부 로그인 일시 차단 (내부망은 계속 사용 가능).
- OTP 설정/해제는 내부망/VPN 에서만 가능. 설정 변경이나 "모든 기기 로그아웃" 시 기존 세션 전부 무효화.
- DSM nginx 는 `X-Real-IP` 를 실제 접속 IP 로 덮어쓰지만 `X-Forwarded-For` 는 클라이언트 값이 그대로 통과하므로, 이 앱은 `X-Real-IP` 만, 그것도 루프백(같은 장비 프록시)에서 온 요청에서만 신뢰합니다.

## 푸시 알림 (Claude Code 완료 / 입력 대기)
Claude Code 가 작업을 마치거나(Stop) 권한·입력을 기다릴 때(Notification) 폰/PC 로 알림을 보냅니다.

1. **HTTPS 주소**로 접속 (브라우저는 HTTPS 에서만 푸시 허용 — 위 "외부에서 접속하기"의 리버스 프록시 주소)
   - Android: Chrome / 삼성 인터넷. 메뉴 → 홈 화면에 추가하면 앱처럼 사용
   - iPhone/iPad (iOS 16.4+): Safari 공유 → **홈 화면에 추가** 후 그 앱에서만 가능
2. **⚙ 설정 → 푸시 알림 → 이 기기에서 받기** → 테스트 알림으로 확인
3. **⚙ 설정 → Claude Code 연동 → 설치 명령 만들기** → 나온 한 줄을 Claude 가 실행되는 곳(WSL·Linux·macOS 터미널)에 붙여 넣기
   ```bash
   curl -fsS 'https://ssh.example.synology.me/api/notify/setup/<1회용 코드>' | sh
   ```
   알림 스크립트(`~/.claude/web-ssh-notify.sh`) 생성 + `~/.claude/settings.json` 에 Stop·Notification 훅 추가(기존 설정 보존) + 새 토큰 발급 + 테스트 알림.
   토큰을 바꾸고 싶을 때도 같은 방법으로 다시 실행합니다. 코드는 10분·1회용입니다.
   - CLI 로 토큰만 발급: `docker exec -u node web-ssh node bin/notify-token.js` (이전 토큰은 무효)

알림에는 호스트 이름·프로젝트 폴더 이름·상태만 담기며 대화 내용은 보내지 않습니다. 알림은 Google/Apple 푸시 서버를 거치지만 내용은 종단 간 암호화됩니다. 알림 토큰으로는 로그인·SSH 접속을 할 수 없습니다.

## 패스키 (지문 · Face ID 로그인)
1. **HTTPS 주소(`PUBLIC_ORIGIN`)** 로 내부망/VPN 에서 접속해 로그인
2. **⚙ 설정 → 패스키 → 이 기기 등록** → 지문/얼굴 인식
3. 다음부터 로그인 화면의 **🔑 지문 · 패스키로 로그인** — 비밀번호·OTP 없이 로그인

사용자 확인(지문·얼굴·PIN)을 필수로 요구하므로 패스키 하나가 2단계 인증을 대신합니다. 등록·삭제는 내부망/VPN 에서만, 로그인은 외부에서도 가능합니다. IP 주소(`http://192.168.x.x`)로 접속하면 브라우저가 패스키를 허용하지 않습니다.

## 모바일 사용 팁
- **한글 입력**: 터미널에 바로 치면 한글 조합이 깨질 수 있어, 폰에서는 하단 **입력창**이 기본입니다. 쓰고 Enter(또는 키 바 ↵) → 전송. 빈 입력창에서 ⌫ 는 터미널에서 지우기. 상단 ⌨ 로 끄고 켤 수 있습니다.
- **스크롤**: 터미널을 손가락으로 위아래로 끌기. tmux 안에서는 `set -g mouse on` 필요 (`extras/tmux.conf`).
- **특수키**: Ctrl·Alt 는 한 번 탭 = 다음 글자 1회, 두 번 탭 = 고정. 방향키·Del 은 길게 누르면 반복.
- **복사**: 상단 📋 → 화면 글자가 일반 텍스트로 열림 → 길게 눌러 선택 → 복사. 

## 복사 (PC · 모바일)
- **앱이 복사하는 경우** (Claude Code 에서 드래그, tmux·vim 의 복사): 앱이 보낸 클립보드 요청(OSC 52)을 브라우저 클립보드로 옮깁니다.
  - **HTTPS 주소에서만** 자동 복사됩니다. `http://IP` 로 접속하면 브라우저가 막으므로 📋 복사 모드를 쓰세요.
  - tmux 안에서는 `set -g set-clipboard on` 필요 (`extras/tmux.conf`).
- **직접 선택**: PC 는 드래그 후 Ctrl+Shift+C (tmux 마우스 모드에서는 **Shift+드래그**), 모바일은 📋 복사 모드.
- **PC 와 폰에서 같은 tmux 세션**: `extras/tmux.conf` 의 `window-size latest` 로 마지막에 입력한 기기 화면 크기에 맞춰집니다.

## 접속 대상 준비
### 시놀로지 NAS 자신
제어판 → 터미널 및 SNMP → SSH 활성화. administrators 그룹 사용자만 로그인 가능. 호스트는 `127.0.0.1` (host 네트워크).

### Windows 10/11
관리자 PowerShell:
```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic; Start-Service sshd
# (선택) 기본 셸을 PowerShell 로
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
```
- 사용자명은 `C:\Users\` 아래 폴더 이름. Microsoft 계정이면 비밀번호는 **MS 계정 비밀번호** (PIN 아님)
- 관리자 계정의 키 인증: `C:\ProgramData\ssh\administrators_authorized_keys`
- WOL: BIOS Wake on LAN + 네트워크 어댑터 전원 관리 "매직 패킷", 빠른 시작 끄기 권장

### WSL 에서 Claude Code 쓰기
폰에서 접속하자마자 WSL 의 tmux 안에서 Claude Code 가 뜨고, 연결이 끊겨도 작업은 계속됩니다.

1. WSL 에 스크립트·설정 복사
   ```bash
   install -m 755 extras/claude-tmux ~/.local/bin/claude-tmux
   cp extras/tmux.conf ~/.tmux.conf      # 이미 있으면 내용만 추가
   ```
2. Windows 호스트를 등록하고 **접속 후 실행 명령**에 (사용자 이름·폴더는 맞게)
   ```
   wsl -d Ubuntu -- bash -l /home/<WSL 사용자>/.local/bin/claude-tmux ~/project claude -r
   ```
   - 인자: `[작업폴더] [tmux 세션 이름] [claude 옵션...]` — `-r` 대화 고르기, `-c` 마지막 대화 이어서
   - 같은 PC 로 호스트를 여러 개 만들 때는 **세션 이름을 다르게** (같으면 기존 세션에 붙기만 함)
   - WSL 셸만 필요하면 `wsl -d Ubuntu --cd ~`
3. tmux 접두키는 키 바의 **^B** (예: `^B` → `c` 새 창, `^B` → `n` 다음 창, `^B` → `d` 빠져나오기)

`wsl … claude` 처럼 바로 실행하면 로그인 셸이 아니라 `~/.local/bin` 이 PATH 에 없어 claude 를 못 찾을 수 있습니다. 스크립트가 `bash -l` 로 이를 해결합니다.

### Hyper-V VM
- **외부 가상 스위치**: VM 이 공유기에서 IP 를 받음 → 그 IP 로 바로 등록
- **Default Switch / 내부 스위치**: 점프 호스트로 Windows PC 선택

## 라이선스
MIT
