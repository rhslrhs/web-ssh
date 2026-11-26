'use strict';
// 📋 복사 창용 tmux 스크롤 기록 가져오기.
// 브라우저 터미널(xterm)은 tmux 안의 지난 출력을 갖고 있지 않으므로(tmux 가 화면만 다시 그림)
// 같은 SSH 연결에서 별도 명령으로 tmux capture-pane 을 실행해 기록을 받아 온다.
//
// 어느 tmux 세션인가: 방금 조작한 클라이언트(= 이 브라우저가 붙은 tmux)가 가장 최근 활동이므로
// client_activity 가 가장 큰 클라이언트의 세션에서 현재 창(pane)을 캡처한다.
// -J: 화면 폭 때문에 접힌 줄을 이어 붙임, -S: 기록 시작 줄
// 스크립트는 base64 로 넘긴다: Windows OpenSSH 의 기본 셸(cmd.exe)을 거쳐 wsl 로 가도 | 따옴표가 깨지지 않게.

const LINES = 3000;
const SCRIPT = [
  'command -v tmux >/dev/null 2>&1 || { echo "tmux 없음" >&2; exit 3; }',
  's=$(tmux list-clients -F "#{client_activity} #{session_name}" 2>/dev/null | sort -rn | head -n1 | cut -d" " -f2-)',
  `if [ -n "$s" ]; then exec tmux capture-pane -pJ -S -${LINES} -t "$s"; fi`,
  // 붙은 클라이언트가 없으면 가장 최근 세션
  `exec tmux capture-pane -pJ -S -${LINES}`,
].join('\n');

// 호스트 실행 명령이 "wsl … -- …" 이면 같은 배포판·사용자 안에서 실행
function wslPrefix(command) {
  const m = /^\s*wsl(?:\.exe)?\s+(.*)$/i.exec(command || '');
  if (!m) return null;
  const head = m[1].split(/\s--(?:\s|$)/)[0].split(/\s+/);
  const out = ['wsl'];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if ((a === '-d' || a === '--distribution' || a === '-u' || a === '--user') && /^[\w.-]+$/.test(head[i + 1] || '')) {
      out.push(a, head[++i]);
    }
  }
  return out.join(' ');
}

function captureCommand(hostCommand) {
  const b64 = Buffer.from(SCRIPT).toString('base64');
  const run = `echo ${b64} | base64 -d | sh`;
  const wsl = wslPrefix(hostCommand);
  return wsl ? `${wsl} -- sh -c "${run}"` : run;
}

// 클라이언트에서 exec 로 실행하고 stdout 을 모아 돌려준다 (최대 크기·시간 제한)
function runCapture(client, hostCommand, { maxBytes = 4 << 20, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, text) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(text); };
    const timer = setTimeout(() => finish(new Error('시간 초과')), timeoutMs);
    client.exec(captureCommand(hostCommand), (err, ch) => {
      if (err) return finish(err);
      const out = [];
      let size = 0;
      let errText = '';
      ch.on('data', (d) => {
        size += d.length;
        if (size > maxBytes) { ch.close(); return finish(new Error('기록이 너무 큽니다')); }
        out.push(d);
      });
      ch.stderr.on('data', (d) => { if (errText.length < 500) errText += d; });
      let code = null;
      ch.on('exit', (c) => { code = c; });
      ch.on('close', (c) => {
        if (code == null) code = c;
        if (code === 0) finish(null, Buffer.concat(out).toString('utf8'));
        else finish(new Error(errText.trim().split('\n')[0] || `종료 코드 ${code}`));
      });
    });
    timer.unref && timer.unref();
  });
}

module.exports = { captureCommand, runCapture, wslPrefix, SCRIPT };
