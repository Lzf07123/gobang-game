// ===== State =====
let token = '';
let username = '';
let ws = null;
let board = [];
let gameStarted = false;
let myColor = 0;    // 1=black, 2=white
let myTurn = false;
let isSpectator = false;
let roomId = '';
let roomPlayers = [];
let spectatorCount = 0;
let lastMove = null;  // {x, y}
let chatMessages = [];
let timerRemaining = 0;
let timerInterval = null;
let matching = false;  // currently in matchmaking queue

// Game records for replay
let gameRecords = JSON.parse(localStorage.getItem('goban_records') || '[]');
let currentMoves = [];  // moves of current game
let replayMode = false;
let replayMoves = [];
let replayIndex = -1;

const SIZE = 15;
const ANIMATION_DURATION = 150; // ms

// Backend URL
const apiPort = document.querySelector('meta[name="api-port"]')?.content;
const httpBase = apiPort ? `http://${location.hostname}:${apiPort}` : '';
const wsBase = apiPort ? `ws://${location.hostname}:${apiPort}` : `ws://${location.host}`;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const CELL = 30;
const PAD = 15;
const BOARD_PX = CELL * (SIZE - 1);   // 420

// ===== Sound =====
let audioCtx = null;

function playSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.12);
  } catch(e) { /* audio not available */ }
}

// ===== Auth =====
async function doLogin() {
  const btn = document.getElementById('login-btn');
  setLoading(btn, true);
  try {
    const res = await apiPost('/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (res.success) {
      token = res.token;
      username = res.username;
      localStorage.setItem('goban_token', token);
      localStorage.setItem('goban_username', username);
      showGameArea(res.username);
      connectWS();
    } else {
      showAuthMsg(res.error, false);
    }
  } catch(e) {
    showAuthMsg('网络错误，请检查连接', false);
  }
  setLoading(btn, false);
}

async function doRegister() {
  const btn = document.getElementById('register-btn');
  setLoading(btn, true);
  try {
    const res = await apiPost('/register', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    showAuthMsg(res.success ? '注册成功，请登录' : res.error, res.success);
  } catch(e) {
    showAuthMsg('网络错误，请检查连接', false);
  }
  setLoading(btn, false);
}

function showAuthMsg(msg, success) {
  const el = document.getElementById('auth-msg');
  el.textContent = msg;
  el.className = success ? 'success' : '';
}

function setLoading(btn, loading) {
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

async function apiPost(path, body) {
  const resp = await fetch(`${httpBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await resp.json();
}

// ===== UI Toggles =====
function showGameArea(user) {
  document.getElementById('auth-area').style.display = 'none';
  document.getElementById('game-area').style.display = 'flex';
  document.getElementById('username-display').textContent = user;
  setStatus(`欢迎，${user}`);
}

function showAuthArea() {
  localStorage.removeItem('goban_token');
  localStorage.removeItem('goban_username');
  document.getElementById('auth-area').style.display = '';
  document.getElementById('game-area').style.display = 'none';
  document.getElementById('cancel-match-btn').style.display = 'none';
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

// ===== WebSocket =====
function connectWS() {
  if (ws) ws.close();
  // Connect WITHOUT token in URL
  ws = new WebSocket(`${wsBase}/ws`);
  ws.onopen = () => {
    // Send auth message immediately
    ws.send(JSON.stringify({ type: 'auth', token }));
  };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => {
    ws = null;
    matching = false;
    if (gameStarted || roomId) {
      setStatus('连接已断开，请重新登录');
      setTimeout(showAuthArea, 2000);
    } else if (localStorage.getItem('goban_token')) {
      setStatus('连接断开，正在重连...');
      setTimeout(() => {
        if (!ws && localStorage.getItem('goban_token')) connectWS();
      }, 2000);
    }
  };
  ws.onerror = () => {};
}

function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      setStatus('已连接，准备就绪');
      resetGameState();
      drawBoard();
      break;

    case 'waiting':
      gameStarted = false;
      matching = true;
      setStatus(data.message);
      document.getElementById('match-btn').disabled = false;
      document.getElementById('match-btn').textContent = '取消匹配';
      document.getElementById('create-room-btn').disabled = true;
      document.getElementById('cancel-match-btn').style.display = '';
      break;

    case 'start':
      gameStarted = true;
      matching = false;
      myColor = data.color;
      myTurn = (myColor === 1);
      isSpectator = false;
      if (data.room_id) roomId = data.room_id;
      if (data.usernames) roomPlayers = data.usernames;
      board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
      lastMove = null;
      currentMoves = [];
      setStatus(data.message);
      document.getElementById('match-btn').disabled = true;
      document.getElementById('create-room-btn').disabled = true;
      document.getElementById('cancel-match-btn').style.display = 'none';
      hideRoomControls();
      showRoomInfo();
      drawBoard();
      break;

    case 'turn':
      myTurn = (data.color === myColor);
      setStatus(myTurn ? '轮到你了' : '等待对手落子...');
      break;

    case 'move':
      board[data.y][data.x] = data.color;
      lastMove = {x: data.x, y: data.y};
      if (!isSpectator) {
        currentMoves.push(data);
        // Wait for own move confirmation too
        if (data.color !== myColor) playSound();
      }
      drawBoard();
      animatePiece(data.x, data.y, data.color);
      break;

    case 'game_over':
      gameStarted = false;
      matching = false;
      document.getElementById('cancel-match-btn').style.display = 'none';
      stopTimer();
      const reason = data.reason ? `（${data.reason}）` : '';
      setStatus(`游戏结束：${data.winner} ${reason}`);
      document.getElementById('match-btn').disabled = false;
      document.getElementById('match-btn').textContent = '再来一局';
      document.getElementById('create-room-btn').disabled = false;
      // Save game record
      if (data.moves) {
        currentMoves = data.moves;
      }
      if (currentMoves.length > 0 && !isSpectator) {
        const opponent = roomPlayers.find(p => p && p !== username) || '对手';
        saveGameRecord(opponent, data.winner, currentMoves);
      }
      break;

    case 'match_cancelled':
      matching = false;
      if (gameStarted) break;
      document.getElementById('match-btn').textContent = '开始匹配';
      document.getElementById('match-btn').disabled = false;
      document.getElementById('create-room-btn').disabled = false;
      document.getElementById('room-controls').style.display = '';
      document.getElementById('cancel-match-btn').style.display = 'none';
      setStatus(data.message);
      break;

    case 'error':
      if (data.error && (data.error.includes('Token') || data.error.includes('认证'))) {
        localStorage.removeItem('goban_token');
        localStorage.removeItem('goban_username');
        showAuthArea();
        return;
      }
      setStatus(`错误：${data.error}`);
      break;

    // Room system messages
    case 'room_created':
      roomId = data.room_id;
      showRoomInfo();
      break;

    case 'room_joined':
      roomId = data.room_id;
      isSpectator = data.as_spectator || false;
      roomPlayers = data.players || [];
      spectatorCount = data.spectator_count || 0;
      if (data.state === 'playing' || data.state === 'finished') {
        gameStarted = (data.state === 'playing');
      }
      showRoomInfo();
      updateSpectatorInfo();
      hideRoomControls();
      document.getElementById('match-btn').disabled = true;
      document.getElementById('create-room-btn').disabled = true;
      if (isSpectator) {
        setStatus('您以观众身份进入房间');
      }
      break;

    case 'player_joined':
      setStatus(`${data.username} 加入了房间`);
      appendChatMessage('系统', `${data.username} 加入了房间`);
      break;

    case 'player_left':
      appendChatMessage('系统', `${data.username} 离开了房间`);
      break;

    case 'spectator_count':
      spectatorCount = data.count;
      updateSpectatorInfo();
      break;

    // Chat
    case 'chat':
      appendChatMessage(data.username, data.message);
      break;

    // Timer
    case 'timer':
      timerRemaining = data.remaining;
      updateTimerDisplay();
      break;
  }
}

// ===== Room System =====
function createRoom() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    setTimeout(() => ws.send(JSON.stringify({ type: 'create_room' })), 500);
    return;
  }
  ws.send(JSON.stringify({ type: 'create_room' }));
  setStatus('正在创建房间...');
  document.getElementById('create-room-btn').disabled = true;
  document.getElementById('match-btn').disabled = true;
}

function joinRoom() {
  const input = document.getElementById('room-code-input');
  const code = input.value.trim().toUpperCase();
  if (!code || code.length < 4) {
    setStatus('请输入4位房间码');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    setTimeout(() => ws.send(JSON.stringify({ type: 'join_room', room_id: code })), 500);
    return;
  }
  ws.send(JSON.stringify({ type: 'join_room', room_id: code }));
  setStatus(`正在加入房间 ${code}...`);
  input.value = '';
}

function spectateRoom() {
  const input = document.getElementById('spectate-code-input');
  const code = input.value.trim().toUpperCase();
  if (!code || code.length < 4) {
    setStatus('请输入4位房间码');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    setTimeout(() => ws.send(JSON.stringify({ type: 'join_room', room_id: code, as_spectator: true })), 500);
    return;
  }
  ws.send(JSON.stringify({ type: 'join_room', room_id: code, as_spectator: true }));
  setStatus(`正在观战房间 ${code}...`);
  input.value = '';
}

function leaveRoom() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'leave_room' }));
  }
  resetGameState();
  document.getElementById('match-btn').disabled = false;
  document.getElementById('match-btn').textContent = '开始匹配';
  document.getElementById('create-room-btn').disabled = false;
  hideRoomInfo();
  document.getElementById('room-controls').style.display = '';
  hideSpectatorInfo();
  drawBoard();
  setStatus('已离开房间');
}

function showRoomInfo() {
  const el = document.getElementById('room-info');
  el.style.display = '';
  const codeEl = document.getElementById('room-code-display');
  if (codeEl) codeEl.textContent = roomId;
  el.querySelector('.room-players').textContent =
    roomPlayers.filter(Boolean).join(' vs ') || '等待对手...';
  document.getElementById('leave-btn').style.display = '';
}

function hideRoomInfo() {
  document.getElementById('room-info').style.display = 'none';
  document.getElementById('leave-btn').style.display = 'none';
}

function hideRoomControls() {
  document.getElementById('room-controls').style.display = 'none';
}

function updateSpectatorInfo() {
  const el = document.getElementById('spectator-info');
  if (spectatorCount > 0) {
    el.style.display = '';
    el.querySelector('.spectator-count').textContent = `${spectatorCount}人`;
  } else {
    el.style.display = 'none';
  }
}

function hideSpectatorInfo() {
  document.getElementById('spectator-info').style.display = 'none';
}

// ===== Match =====
function startMatch() {
  const btn = document.getElementById('match-btn');

  // If already matching, cancel instead
  if (matching) {
    cancelMatch();
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    setTimeout(() => ws.send(JSON.stringify({ type: 'match' })), 500);
    return;
  }
  ws.send(JSON.stringify({ type: 'match' }));
  setStatus('正在匹配...');
  matching = true;
  btn.textContent = '取消匹配';
  btn.disabled = false;
  document.getElementById('create-room-btn').disabled = true;
  document.getElementById('room-controls').style.display = 'none';
  document.getElementById('cancel-match-btn').style.display = '';
}

function cancelMatch() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cancel_match' }));
  }
  matching = false;
  const btn = document.getElementById('match-btn');
  btn.textContent = '开始匹配';
  btn.disabled = false;
  document.getElementById('create-room-btn').disabled = false;
  document.getElementById('room-controls').style.display = '';
  document.getElementById('cancel-match-btn').style.display = 'none';
  setStatus('已取消匹配');
}

// ===== Room Browser =====
let roomBrowserInterval = null;
let roomBrowserRooms = [];

async function browseRooms() {
  if (!roomBrowserInterval) {
    await fetchAndShowRooms();
    roomBrowserInterval = setInterval(fetchAndShowRooms, 5000);
  }
}

async function fetchAndShowRooms() {
  try {
    const resp = await fetch(`${httpBase}/api/rooms`);
    const data = await resp.json();
    roomBrowserRooms = data.rooms || [];
    showRoomBrowserOverlay();
  } catch(e) {
    // silently retry on next interval
  }
}

function showRoomBrowserOverlay() {
  const overlay = document.getElementById('room-browser');
  const list = overlay.querySelector('.room-browser-items');
  list.innerHTML = '';
  if (roomBrowserRooms.length === 0) {
    list.innerHTML = '<div class="replay-empty">暂无等待中的房间</div>';
  } else {
    roomBrowserRooms.forEach(r => {
      const el = document.createElement('div');
      el.className = 'room-browser-item';
      el.innerHTML = `
        <span class="room-browser-code">${r.room_id}</span>
        <span class="room-browser-creator">${r.creator || '未知'}</span>
        <button class="btn-small room-browser-join" data-room="${r.room_id}">加入</button>
      `;
      el.querySelector('.room-browser-join').onclick = () => {
        document.getElementById('room-code-input').value = r.room_id;
        hideRoomBrowser();
        joinRoom();
      };
      list.appendChild(el);
    });
  }
  overlay.style.display = 'flex';
}

function hideRoomBrowser() {
  document.getElementById('room-browser').style.display = 'none';
  if (roomBrowserInterval) {
    clearInterval(roomBrowserInterval);
    roomBrowserInterval = null;
  }
}
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !ws || ws.readyState !== WebSocket.OPEN || !roomId) return;
  ws.send(JSON.stringify({ type: 'chat', message: msg }));
  input.value = '';
}

function appendChatMessage(user, msg) {
  chatMessages.push({ user, msg });
  const container = document.getElementById('chat-messages');
  const maxMsgs = 100;
  if (chatMessages.length > maxMsgs) {
    chatMessages = chatMessages.slice(-maxMsgs);
  }
  const el = document.createElement('div');
  el.className = 'chat-msg';
  if (user === '系统') el.className += ' system';
  el.innerHTML = user === '系统'
    ? `<span class="chat-system">${msg}</span>`
    : `<span class="chat-user">${user}:</span> <span class="chat-text">${escapeHtml(msg)}</span>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ===== Timer =====
function updateTimerDisplay() {
  const el = document.getElementById('timer-display');
  if (!el) return;
  if (timerRemaining > 0) {
    el.style.display = '';
    el.textContent = `${timerRemaining}s`;
    el.className = timerRemaining <= 10 ? 'timer-warning' : '';
  } else {
    el.style.display = 'none';
  }
}

function stopTimer() {
  timerRemaining = 0;
  updateTimerDisplay();
}

// ===== Game Records (Replay) =====
function saveGameRecord(opponent, result, moves) {
  const records = JSON.parse(localStorage.getItem('goban_records') || '[]');
  records.unshift({
    id: Date.now(),
    date: new Date().toISOString(),
    opponent,
    result,
    moves: moves.map(m => ({
      x: m.x !== undefined ? m.x : m[0],
      y: m.y !== undefined ? m.y : m[1],
      color: m.color !== undefined ? m.color : m[2],
    })),
  });
  // Keep last 50 records
  localStorage.setItem('goban_records', JSON.stringify(records.slice(0, 50)));
  gameRecords = records.slice(0, 50);
}

function showReplayList() {
  const records = JSON.parse(localStorage.getItem('goban_records') || '[]');
  const overlay = document.getElementById('replay-list');
  const list = overlay.querySelector('.replay-items');
  list.innerHTML = '';
  if (records.length === 0) {
    list.innerHTML = '<div class="replay-empty">暂无对局记录</div>';
  } else {
    records.forEach((rec, idx) => {
      const el = document.createElement('div');
      el.className = 'replay-item';
      const date = new Date(rec.date);
      const dateStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
      el.innerHTML = `
        <span class="replay-info">${dateStr} vs ${rec.opponent}</span>
        <span class="replay-result">${rec.result}</span>
        <button onclick="startReplay(${idx})">回放</button>
      `;
      list.appendChild(el);
    });
  }
  overlay.style.display = 'flex';
}

function hideReplayList() {
  document.getElementById('replay-list').style.display = 'none';
}

function startReplay(idx) {
  const records = JSON.parse(localStorage.getItem('goban_records') || '[]');
  if (!records[idx]) return;
  const rec = records[idx];
  replayMoves = rec.moves;
  replayIndex = -1;
  replayMode = true;
  document.getElementById('replay-list').style.display = 'none';

  // Switch to replay mode in UI
  document.getElementById('replay-controls').style.display = '';
  document.getElementById('match-btn').disabled = true;
  document.getElementById('create-room-btn').disabled = true;
  document.getElementById('room-controls').style.display = 'none';

  board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  setStatus(`回放: ${rec.opponent} (${rec.result}) - 第 0 手`);
  drawBoard();
}

function replayStep(forward) {
  if (!replayMode) return;
  if (forward) {
    if (replayIndex >= replayMoves.length - 1) return;
    replayIndex++;
    const m = replayMoves[replayIndex];
    board[m.y][m.x] = m.color;
    lastMove = {x: m.x, y: m.y};
  } else {
    if (replayIndex < 0) return;
    const m = replayMoves[replayIndex];
    board[m.y][m.x] = 0;
    replayIndex--;
    // Recalculate lastMove
    if (replayIndex >= 0) {
      const prev = replayMoves[replayIndex];
      lastMove = {x: prev.x, y: prev.y};
    } else {
      lastMove = null;
    }
  }
  setStatus(`回放: 第 ${replayIndex + 1} 手 (共 ${replayMoves.length} 手)`);
  drawBoard();
}

function exitReplay() {
  replayMode = false;
  replayMoves = [];
  replayIndex = -1;
  lastMove = null;
  document.getElementById('replay-controls').style.display = 'none';
  document.getElementById('match-btn').disabled = false;
  document.getElementById('create-room-btn').disabled = false;
  document.getElementById('room-controls').style.display = '';
  resetGameState();
  drawBoard();
  setStatus('已退出回放');
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

  // Star points
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

  // Last move marker
  if (lastMove && board[lastMove.y][lastMove.x] !== 0) {
    drawLastMoveMarker(lastMove.x, lastMove.y, board[lastMove.y][lastMove.x]);
  }

  // Coordinate labels
  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String.fromCharCode(65 + i), PAD + i * CELL, 0);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String(SIZE - i), 0, PAD + i * CELL);
  }
}

function drawPiece(x, y, color, scale) {
  const cx = PAD + x * CELL;
  const cy = PAD + y * CELL;
  const r = (CELL * 0.42) * (scale || 1);

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

function drawLastMoveMarker(x, y, color) {
  const cx = PAD + x * CELL;
  const cy = PAD + y * CELL;
  const r = 4;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color === 1 ? '#ff4444' : '#ff4444';
  ctx.fill();
}

function animatePiece(x, y, color) {
  let start = null;
  const animCanvas = document.createElement('canvas');
  animCanvas.width = canvas.width;
  animCanvas.height = canvas.height;
  const animCtx = animCanvas.getContext('2d');

  function frame(timestamp) {
    if (!start) start = timestamp;
    const elapsed = timestamp - start;
    const progress = Math.min(elapsed / ANIMATION_DURATION, 1);

    // Ease out bounce
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const scale = easeOut;

    // We need to redraw board underneath then draw scaled piece
    drawBoard();
    drawPiece(x, y, color, scale);
    elapsed < ANIMATION_DURATION ? requestAnimationFrame(frame) : drawBoard();
  }
  requestAnimationFrame(frame);
}

// ===== Click / Touch =====
function handleCanvasInput(clientX, clientY) {
  if (!gameStarted || !myTurn || isSpectator) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (clientX - rect.left) * scaleX;
  const py = (clientY - rect.top) * scaleY;

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

  if (bestDist > (CELL / 2) ** 2 || board[by][bx] !== 0) return;

  ws.send(JSON.stringify({ type: 'move', x: bx, y: by }));
  myTurn = false;
  setStatus('等待对手落子...');
}

canvas.addEventListener('click', (e) => {
  handleCanvasInput(e.clientX, e.clientY);
});

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  handleCanvasInput(touch.clientX, touch.clientY);
}, { passive: false });

// Keyboard shortcut: Enter to send chat
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const chatInput = document.getElementById('chat-input');
    if (chatInput === document.activeElement) {
      sendChat();
    }
  }
});

// ===== Helpers =====
function setStatus(msg) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = msg;
}

function resetGameState() {
  gameStarted = false;
  matching = false;
  myColor = 0;
  myTurn = false;
  isSpectator = false;
  lastMove = null;
  timerRemaining = 0;
  roomPlayers = [];
  spectatorCount = 0;
  updateTimerDisplay();
  hideRoomInfo();
  hideSpectatorInfo();
  document.getElementById('cancel-match-btn').style.display = 'none';
  board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  currentMoves = [];
  chatMessages = [];
  document.getElementById('chat-messages').innerHTML = '';
}

// ===== Canvas Sizing (Responsive) =====
function resizeCanvas() {
  const maxWidth = Math.min(window.innerWidth - 40, 480);
  const maxHeight = window.innerHeight - 220;
  const size = Math.min(maxWidth, maxHeight, 480);
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ===== Chat toggle for mobile =====
function toggleChat() {
  const panel = document.getElementById('chat-panel');
  panel.classList.toggle('collapsed');
}

// ===== Auto-login from localStorage =====
(function init() {
  const savedToken = localStorage.getItem('goban_token');
  const savedUsername = localStorage.getItem('goban_username');
  if (savedToken && savedUsername) {
    token = savedToken;
    username = savedUsername;
    showGameArea(username);
    connectWS();
  }
})();
