// 2Captcha simulado para los tests: responde como la API real (in.php / res.php).
const http = require('http');

const port = Number(process.env.FAKE_PORT || 4110);
const code = process.env.FAKE_CODE || 'Z8VQ';
const notReady = Number(process.env.FAKE_NOT_READY || 0);
const failFirstTask = process.env.FAKE_FAIL_FIRST === '1';

let taskCounter = 0;
const polls = {};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/in.php') {
    taskCounter += 1;
    res.end(JSON.stringify({ status: 1, request: String(taskCounter) }));
    return;
  }

  if (url.pathname === '/res.php') {
    const action = url.searchParams.get('action');
    if (action === 'getbalance') {
      res.end(JSON.stringify({ status: 1, request: '5.00' }));
      return;
    }
    const id = url.searchParams.get('id') || '0';
    polls[id] = (polls[id] || 0) + 1;
    if (failFirstTask && id === '1') {
      if (polls[id] < 2) { res.end(JSON.stringify({ status: 0, request: 'CAPCHA_NOT_READY' })); return; }
      res.end(JSON.stringify({ status: 0, request: 'ERROR_CAPTCHA_UNSOLVABLE' }));
      return;
    }
    if (polls[id] <= notReady) {
      res.end(JSON.stringify({ status: 0, request: 'CAPCHA_NOT_READY' }));
      return;
    }
    res.end(JSON.stringify({ status: 1, request: code }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ status: 0, request: 'ERROR' }));
});

server.listen(port, '127.0.0.1', () => console.log(`[fake-2captcha] en ${port}`));
