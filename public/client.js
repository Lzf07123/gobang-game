// ===== State =====
let token = '';
let username = '';
let ws = null;
let board = [];
let gameStarted = false;
let myColor = 0;    // 1=black, 2=white
let myTurn = false;
const SIZE = 15;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const CELL = 30;
const PAD = 15;
const BOARD_PX = CELL * (SIZE - 1);   // 420

// ===== Auth =====
async function doLogin() {
  const res = await apiPost('/login', {
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
  });
  if (res.success) {
    token = res.token;
    username = res.username;
    document.getElementById('auth-area').style.display = 'none';
    document.getElementById('game-area').style.display = 'flex';
    setStatus(`欢迎，${username}`);
    connectWS();
  } else {
    document.getElementById('auth-msg').textContent = res.error;
  }
}

async function doRegister() {
  const res = await apiPost('/register', {
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
  });
  document.getElementById('auth-msg').textContent = res.success ? '注册成功，请登录' : res.error;
}

async function apiPost(path, body) {
  const resp = await fetch(`http://${location.hostname}:8080${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await resp.json();
}

// ===== WebSocket =====
function connectWS() {
  if (ws) ws.close();
  ws = new WebSocket(`ws://${location.hostname}:8080/ws?token=${token}`);

  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (gameStarted) {
      setStatus('连接断开，请刷新页面重新登录');
    }
    ws = null;
  };
  ws.onerror = () => {};
}

function handleMessage(data) {
  switch (data.type) {
    case 'waiting':
      gameStarted = false;
      setStatus(data.message);
      document.getElementById('match-btn').disabled = true;
      break;

    case 'start':
      gameStarted = true;
      myColor = data.color;
      myTurn = (myColor === 1);  // black goes first
      board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
      setStatus(`${data.message}`);
      document.getElementById('match-btn').disabled = true;
      drawBoard();
      break;

    case 'turn':
      myTurn = (data.color === myColor);
      setStatus(myTurn ? '轮到你了' : '等待对手落子...');
      break;

    case 'move':
      board[data.y][data.x] = data.color;
      drawBoard();
      break;

    case 'game_over':
      gameStarted = false;
      setStatus(`游戏结束：${data.winner}`);
      document.getElementById('match-btn').disabled = false;
      document.getElementById('match-btn').textContent = '再来一局';
      break;

    case 'error':
      setStatus(`错误：${data.error}`);
      break;
  }
}

// ===== Match =====
function startMatch() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    setTimeout(() => ws.send(JSON.stringify({ type: 'match' })), 500);
    return;
  }
  ws.send(JSON.stringify({ type: 'match' }));
  setStatus('正在匹配...');
  document.getElementById('match-btn').disabled = true;
}

// ===== Board Drawing =====
function drawBoard() {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#d4a76a';
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const p = PAD + i * CELL;
    ctx.beginPath();
    ctx.moveTo(PAD, p);
    ctx.lineTo(PAD + BOARD_PX, p);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p, PAD);
    ctx.lineTo(p, PAD + BOARD_PX);
    ctx.stroke();
  }

  // Star points (traditional positions on 15x15 board)
  const stars = [[3,3], [3,7], [3,11], [7,3], [7,7], [7,11], [11,3], [11,7], [11,11]];
  ctx.fillStyle = '#333';
  for (const [sx, sy] of stars) {
    ctx.beginPath();
    ctx.arc(PAD + sx * CELL, PAD + sy * CELL, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pieces
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (board[y][x] !== 0) drawPiece(x, y, board[y][x]);
    }
  }
}

function drawPiece(x, y, color) {
  const cx = PAD + x * CELL;
  const cy = PAD + y * CELL;
  const r = CELL * 0.42;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);

  if (color === 1) {
    const grad = ctx.createRadialGradient(cx - 3, cy - 3, 2, cx, cy, r);
    grad.addColorStop(0, '#555');
    grad.addColorStop(1, '#111');
    ctx.fillStyle = grad;
  } else {
    const grad = ctx.createRadialGradient(cx - 3, cy - 3, 2, cx, cy, r);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, '#ccc');
    ctx.fillStyle = grad;
  }
  ctx.fill();
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

// ===== Click =====
canvas.addEventListener('click', (e) => {
  if (!gameStarted || !myTurn) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;

  // Find nearest intersection
  let bestDist = Infinity, bx = -1, by = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const gx = PAD + x * CELL, gy = PAD + y * CELL;
      const d = (px - gx) ** 2 + (py - gy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bx = x;
        by = y;
      }
    }
  }

  // Valid click distance: within half cell
  if (bestDist > (CELL / 2) ** 2 || board[by][bx] !== 0) return;

  ws.send(JSON.stringify({ type: 'move', x: bx, y: by }));
  myTurn = false;
  setStatus('等待对手落子...');
});

// ===== Helpers =====
function setStatus(msg) {
  document.getElementById('status-text').textContent = msg;
}
