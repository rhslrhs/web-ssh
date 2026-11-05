#!/bin/sh
# .env 생성기 — 무작위 APP_PASSWORD / SECRET_KEY, WOL 브로드캐스트 자동 감지, 데이터 폴더 생성
#
#   ./gen-env.sh                                   # 내부망(LAN/VPN) 전용
#   ./gen-env.sh --domain ssh.example.synology.me  # 외부 접속(리버스 프록시) 설정 포함
#   ./gen-env.sh --domain ssh.example.synology.me --allow 203.0.113.7
#   ./gen-env.sh -f                                # 기존 .env 백업 후 다시 생성
set -eu

cd "$(dirname "$0")"
OUT=.env
FORCE=0
DOMAIN=""
ALLOW=""
PORT=8822
PASSWORD=""

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--force) FORCE=1 ;;
    --domain) DOMAIN="${2:?--domain 값 필요}"; shift ;;
    --allow) ALLOW="${2:?--allow 값 필요}"; shift ;;
    --port) PORT="${2:?--port 값 필요}"; shift ;;
    --password) PASSWORD="${2:?--password 값 필요}"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage 1 ;;
  esac
  shift
done

if [ -f "$OUT" ] && [ "$FORCE" != 1 ]; then
  echo "$OUT 가 이미 있습니다. 다시 만들려면 -f (기존 파일은 백업됨)." >&2
  echo "주의: SECRET_KEY 가 바뀌면 저장된 SSH 비밀번호/키를 다시 입력해야 합니다." >&2
  exit 1
fi

rand_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
# 헷갈리는 문자(0 O 1 l I) 없는 무작위 문자열
rand_pw() { LC_ALL=C tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' </dev/urandom | head -c "$1"; }

# 앱 비밀번호: --password > 터미널 입력 > 자동 생성
GENERATED=0
if [ -z "$PASSWORD" ] && [ -t 0 ]; then
  printf '앱 로그인 비밀번호 (8자 이상, Enter = 자동 생성): '
  stty -echo 2>/dev/null || true
  read -r PASSWORD || PASSWORD=""
  stty echo 2>/dev/null || true
  echo
fi
if [ -z "$PASSWORD" ]; then PASSWORD=$(rand_pw 20); GENERATED=1; fi
if [ ${#PASSWORD} -lt 8 ]; then echo "비밀번호는 8자 이상이어야 합니다." >&2; exit 1; fi
case "$PASSWORD" in *[\'\"\ \$\`\\]*) echo "비밀번호에 공백/따옴표/\$/\`/\\ 는 쓸 수 없습니다." >&2; exit 1 ;; esac

# WOL 브로드캐스트: 기본 경로 인터페이스의 brd 주소
BRD=""
if command -v ip >/dev/null 2>&1; then
  IFACE=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
  [ -n "${IFACE:-}" ] && BRD=$(ip -4 addr show dev "$IFACE" 2>/dev/null | awk '/ brd /{for(i=1;i<NF;i++) if($i=="brd"){print $(i+1); exit}}')
fi
[ -n "$BRD" ] || BRD=255.255.255.255

if [ -n "$DOMAIN" ]; then
  DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%%/*}
  TRUST=1; PUBLIC=1; ORIGIN="https://$DOMAIN"
else
  TRUST=0; PUBLIC=0; ORIGIN=""
fi

if [ -f "$OUT" ]; then
  BAK="$OUT.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$OUT" "$BAK"
  echo "기존 $OUT → $BAK 백업"
fi

umask 077
cat > "$OUT" <<EOF
# gen-env.sh 로 생성 ($(date '+%Y-%m-%d %H:%M'))
APP_PASSWORD=$PASSWORD
SECRET_KEY=$(rand_hex 32)
PORT=$PORT
WOL_BROADCAST=$BRD
SESSION_IDLE_MIN=30
SESSION_MAX_HOURS=168
TRUST_PROXY=$TRUST
PUBLIC_ACCESS=$PUBLIC
ALLOW_PUBLIC_IPS=$ALLOW
PUBLIC_ORIGIN=$ORIGIN
EOF
chmod 600 "$OUT"

# docker-compose.yml 이 쓰는 데이터 폴더 (시놀로지는 자동 생성 안 함)
mkdir -p ../web-ssh-data

echo "✓ $OUT 생성 (권한 600), 데이터 폴더 ../web-ssh-data 준비"
echo "  (WOL 브로드캐스트는 이 장비 기준 감지값 — 공유기 대역과 다르면 .env 수정)"
echo "  포트 $PORT · WOL 브로드캐스트 $BRD · 외부 접속 $( [ "$PUBLIC" = 1 ] && echo "켜짐 ($ORIGIN)" || echo 꺼짐 )"
if [ "$GENERATED" = 1 ]; then
  echo
  echo "  앱 비밀번호: $PASSWORD"
  echo "  (지금 비밀번호 관리자에 저장하세요. 나중에 보려면 .env 확인)"
fi
if [ "$PUBLIC" = 1 ]; then
  echo
  echo "  외부 접속 전에: 내부망에서 로그인 → 보안 → 2단계 인증 설정 (OTP 가 없으면 외부 로그인은 거부됨)"
  [ -n "$ALLOW" ] || echo "  권장: --allow <회사 공인 IP> 로 외부 허용 IP 제한"
fi
echo
echo "다음: docker compose up -d --build   (구버전: docker-compose up -d --build)"
