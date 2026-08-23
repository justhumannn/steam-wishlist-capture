'use strict';

/* 로컬에서 실행할 때 쓰는 껍데기. 실제 처리는 router.js가 한다. */

const http = require('http');
const { route } = require('./router');

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    const result = await route(req.method, url.pathname, url.searchParams);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '알 수 없는 오류가 발생했습니다.' }));
  }
});

server.listen(PORT, () => {
  console.log('\n  스팀 찜 목록 카드 메이커\n  → http://localhost:' + PORT + '\n');
});
