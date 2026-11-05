'use strict';
const fs = require('fs');

// JSON 파일 읽기/원자적 쓰기 (임시 파일에 쓴 뒤 rename → 중간에 죽어도 파일이 깨지지 않음)
function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJsonAtomic };
