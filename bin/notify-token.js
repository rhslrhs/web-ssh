#!/usr/bin/env node
'use strict';
// 알림 토큰 발급 (CLI). 기존 토큰은 그대로 두고 하나를 더 만든다 (⚙ 설정에서 개별 삭제).
//   docker exec -u node web-ssh node bin/notify-token.js [이름]
const token = require('../lib/notifytoken').issue(process.argv[2] || `CLI · ${new Date().toLocaleDateString('ko-KR')}`);
console.log(token);
