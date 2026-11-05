#!/usr/bin/env node
'use strict';
// 알림 토큰 발급 (CLI). 기존 토큰은 무효가 된다.
//   docker exec -u node web-ssh node bin/notify-token.js
const token = require('../lib/notifytoken').issue();
console.log(token);
