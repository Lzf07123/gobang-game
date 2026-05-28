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
let winLine = null;   // [{x, y}, ...] 5 winning coordinates
let chatMessages = [];
let timerRemaining = 0;
let timerInterval = null;
let matching = false;  // currently in matchmaking queue
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT = 8;

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
const isHttps = location.protocol === 'https:';
const wsProtocol = isHttps ? 'wss:' : 'ws:';

// When the page is HTTPS, assume reverse proxy — use same-origin URLs,
// since mixed content (HTTPS page → HTTP backend) is blocked by browsers.
const sameOrigin = !apiPort || isHttps;
const httpBase = sameOrigin ? '' : `http://${location.hostname}:${apiPort}`;
const wsBase = sameOrigin
  ? `${wsProtocol}//${location.host}`
  : `${wsProtocol}//${location.hostname}:${apiPort}`;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const CELL = 30;
const PAD = 15;
const BOARD_PX = CELL * (SIZE - 1);   // 420

// ===== Sound =====
let audioCtx = null;
let soundEnabled = localStorage.getItem('goban_sound') !== 'false';

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('goban_sound', soundEnabled);
  document.getElementById('sound-toggle-btn').textContent = soundEnabled ? '🔊' : '🔇';
}

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playPlaceSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
  } catch(e) { /* audio not available */ }
}

function playStartSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    [523, 659, 784].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.12;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.start(t);
      osc.stop(t + 0.15);
    });
  } catch(e) {}
}

function playWinSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    [523, 659, 784, 1047].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.15;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch(e) {}
}

function playLoseSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    [400, 350, 300].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'triangle';
      const t = ctx.currentTime + i * 0.2;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch(e) {}
}

function playTickSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.05);
  } catch(e) {}
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
  document.getElementById('avatar').textContent = user.charAt(0).toUpperCase();
  document.getElementById('logout-btn').style.display = '';
  setStatus(`欢迎，${user}`);
}

function showAuthArea() {
  localStorage.removeItem('goban_token');
  localStorage.removeItem('goban_username');
  document.getElementById('auth-area').style.display = '';
  document.getElementById('game-area').style.display = 'none';
  document.getElementById('cancel-match-btn').style.display = 'none';
  document.getElementById('logout-btn').style.display = 'none';
  document.getElementById('profile-panel').style.display = 'none';
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

// ===== WebSocket =====
function connectWS() {
  if (ws) { ws.onclose = null; ws.close(); }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  ws = new WebSocket(`${wsBase}/ws`);
  ws.onopen = () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'auth', token }));
  };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => {
    ws = null;
    matching = false;
    if (reconnectAttempts >= MAX_RECONNECT) {
      setStatus('连接失败，请刷新页面重试');
      reconnectAttempts = 0;
      return;
    }
    if (gameStarted || roomId) {
      reconnectAttempts++;
      const delay = Math.min(10000, 1000 * Math.pow(2, reconnectAttempts))
                    + Math.random() * 1000;
      setStatus(`连接断开，${Math.round(delay/1000)}秒后重连(${reconnectAttempts}/${MAX_RECONNECT})...`);
      reconnectTimer = setTimeout(() => {
        if (localStorage.getItem('goban_token')) connectWS();
      }, delay);
    } else if (localStorage.getItem('goban_token')) {
      reconnectAttempts++;
      const delay = Math.min(10000, 1000 * Math.pow(2, reconnectAttempts))
                    + Math.random() * 500;
      setStatus(`连接断开，正在重连(${reconnectAttempts}/${MAX_RECONNECT})...`);
      reconnectTimer = setTimeout(() => {
        if (!ws && localStorage.getItem('goban_token')) connectWS();
      }, delay);
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
      document.getElementById('game-actions').style.display = '';
      document.getElementById('rematch-actions').style.display = 'none';
      document.getElementById('rematch-btn').disabled = false;
      document.getElementById('rematch-btn').textContent = '再来一局';
      drawBoard();
      playStartSound();
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
        if (data.color !== myColor) playPlaceSound();
      }
      drawBoard();
      animatePiece(data.x, data.y, data.color);
      break;

    case 'game_over':
      gameStarted = false;
      matching = false;
      winLine = data.win_line || null;
      document.getElementById('cancel-match-btn').style.display = 'none';
      document.getElementById('game-actions').style.display = 'none';
      stopTimer();
      const goReason = data.reason ? `（${data.reason}）` : '';
      setStatus(`游戏结束：${data.winner} ${goReason}`);
      document.getElementById('match-btn').disabled = false;
      document.getElementById('match-btn').textContent = '开始匹配';
      document.getElementById('create-room-btn').disabled = false;
      if (!isSpectator && roomId) {
        document.getElementById('rematch-actions').style.display = '';
      }
      if (data.winner === username) {
        playWinSound();
      } else if (data.winner !== '平局') {
        playLoseSound();
      }
      if (data.moves) {
        currentMoves = data.moves;
      }
      if (currentMoves.length > 0 && !isSpectator) {
        const opponent = roomPlayers.find(p => p && p !== username) || '对手';
        saveGameRecord(opponent, data.winner, currentMoves);
      }
      break;

    case 'rematch_request':
      setStatus(`${data.from} 邀请你再来一局`);
      document.getElementById('rematch-actions').style.display = '';
      break;

    case 'rematch_waiting':
      setStatus('已发送再来一局请求，等待对方确认...');
      document.getElementById('rematch-btn').disabled = true;
      document.getElementById('rematch-btn').textContent = '等待中...';
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

    case 'room_closed':
      if (!replayMode) {
        resetGameState();
        document.getElementById('match-btn').disabled = false;
        document.getElementById('match-btn').textContent = '开始匹配';
        document.getElementById('create-room-btn').disabled = false;
        document.getElementById('room-controls').style.display = '';
        hideRoomInfo();
        hideSpectatorInfo();
        drawBoard();
        setStatus(data.message || '房间已关闭');
      }
      break;

    // Undo
    case 'request_undo':
      document.getElementById('undo-message').textContent = `${data.from} 请求悔棋`;
      document.getElementById('undo-overlay').style.display = 'flex';
      break;

    case 'undo_response':
      document.getElementById('undo-overlay').style.display = 'none';
      if (!data.accepted) {
        setStatus('悔棋请求被拒绝');
      }
      break;

    case 'undo':
      board = data.board.map(row => row.slice());
      currentMoves = data.moves.slice();
      lastMove = currentMoves.length > 0
        ? { x: currentMoves[currentMoves.length - 1][0], y: currentMoves[currentMoves.length - 1][1] }
        : null;
      drawBoard();
      setStatus('已悔棋');
      break;

    // Timer
    case 'timer':
      timerRemaining = data.remaining;
      updateTimerDisplay();
      if (timerRemaining <= 5 && timerRemaining > 0 && myTurn) {
        playTickSound();
      }
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
  document.getElementById('copy-room-btn').style.display = '';
}

function copyRoomCode() {
  if (!roomId) return;
  const btn = document.getElementById('copy-room-btn');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(roomId).then(() => {
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '📋'; }, 1500);
    }).catch(() => {
      btn.textContent = '✗';
      setTimeout(() => { btn.textContent = '📋'; }, 1500);
    });
  } else {
    const input = document.createElement('input');
    input.value = roomId;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '📋'; }, 1500);
  }
}

// ===== Theme =====
const THEME_KEY = 'goban_theme';

function setTheme(name) {
  document.body.setAttribute('data-theme', name);
  localStorage.setItem(THEME_KEY, name);
  document.querySelectorAll('.theme-dot').forEach(d => d.classList.remove('active'));
  const dot = document.querySelector(`.theme-dot.${name}`);
  if (dot) dot.classList.add('active');
  drawBoard();
}

function getThemeColors() {
  const themes = {
    classic: { bg: '#d4a76a', grid: '#333', star: '#333', black1: '#555', black2: '#111', white1: '#fff', white2: '#ccc', lastMove: '#ff4444', winGlow: '255,215,0', label: '#666' },
    light:   { bg: '#f0d9b5', grid: '#555', star: '#555', black1: '#333', black2: '#000', white1: '#fff', white2: '#ddd', lastMove: '#e74c3c', winGlow: '231,76,60', label: '#888' },
    dark:    { bg: '#2c3e50', grid: '#5d7b93', star: '#7f9cb5', black1: '#bdc3c7', black2: '#2c3e50', white1: '#ecf0f1', white2: '#bdc3c7', lastMove: '#e74c3c', winGlow: '241,196,15', label: '#7f9cb5' },
    bamboo:  { bg: '#a8c97e', grid: '#4a6741', star: '#4a6741', black1: '#2d3436', black2: '#111', white1: '#f5f5dc', white2: '#e8e8c0', lastMove: '#d63031', winGlow: '255,215,0', label: '#5a7a4a' },
  };
  return themes[localStorage.getItem(THEME_KEY) || 'classic'];
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'classic';
  document.body.setAttribute('data-theme', saved);
  document.querySelectorAll('.theme-dot').forEach(d => d.classList.remove('active'));
  const dot = document.querySelector(`.theme-dot.${saved}`);
  if (dot) dot.classList.add('active');
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

// ===== Rematch =====
function requestRematch() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'rematch' }));
  setStatus('已发送再来一局请求...');
  document.getElementById('rematch-btn').disabled = true;
  document.getElementById('rematch-btn').textContent = '等待中...';
}

// ===== Undo =====
function requestUndo() {
  if (!ws || !gameStarted || !myTurn) return;
  ws.send(JSON.stringify({ type: 'request_undo' }));
  setStatus('已发送悔棋请求...');
}

function respondUndo(accept) {
  if (!ws) return;
  ws.send(JSON.stringify({ type: 'undo_response', accept }));
  document.getElementById('undo-overlay').style.display = 'none';
}

// ===== Resign =====
function doResign() {
  if (!ws || !gameStarted) return;
  if (!confirm('确定要认输吗？')) return;
  ws.send(JSON.stringify({ type: 'resign' }));
}

// ===== Profile =====
async function toggleProfile() {
  const panel = document.getElementById('profile-panel');
  if (panel.style.display === 'none' || !panel.style.display) {
    panel.style.display = 'block';
    try {
      const resp = await fetch(`${httpBase}/api/profile?username=${encodeURIComponent(username)}`);
      const data = await resp.json();
      document.getElementById('stat-total').textContent = data.total_games || 0;
      document.getElementById('stat-wins').textContent = data.wins || 0;
      const rate = data.total_games > 0 ? Math.round((data.wins / data.total_games) * 100) + '%' : '-';
      document.getElementById('stat-rate').textContent = rate;
    } catch(e) {
      document.getElementById('stat-total').textContent = '0';
      document.getElementById('stat-wins').textContent = '0';
      document.getElementById('stat-rate').textContent = '-';
    }
    document.querySelector('.profile-name').textContent = username;
    document.querySelector('.profile-avatar-large').textContent = username.charAt(0).toUpperCase();
  } else {
    panel.style.display = 'none';
  }
}

function doLogout() {
  localStorage.removeItem('goban_token');
  localStorage.removeItem('goban_username');
  document.getElementById('profile-panel').style.display = 'none';
  showAuthArea();
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
  while (chatMessages.length > maxMsgs) {
    chatMessages.shift();
    if (container.firstChild) container.removeChild(container.firstChild);
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

async function showReplayList() {
  const overlay = document.getElementById('replay-list');
  const list = overlay.querySelector('.replay-items');
  list.innerHTML = '<div class="replay-empty">加载中...</div>';
  overlay.style.display = 'flex';

  let serverGames = [];
  try {
    const resp = await fetch(`${httpBase}/api/games?username=${encodeURIComponent(username)}`);
    const data = await resp.json();
    serverGames = data.games || [];
  } catch(e) { /* fallback to localStorage */ }

  if (serverGames.length === 0) {
    // Fallback to localStorage
    const records = JSON.parse(localStorage.getItem('goban_records') || '[]');
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
          <button onclick="startReplayLocal(${idx})">回放</button>
        `;
        list.appendChild(el);
      });
    }
    return;
  }

  list.innerHTML = '';
  serverGames.forEach(g => {
    const el = document.createElement('div');
    el.className = 'replay-item';
    const opp = g.black_username === username ? g.white_username : g.black_username;
    const date = new Date(g.created_at);
    const dateStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
    el.innerHTML = `
      <span class="replay-info">${dateStr} vs ${opp || '未知'}</span>
      <span class="replay-result">${g.winner}</span>
      <button onclick="startReplayServer(${g.id})">回放</button>
    `;
    list.appendChild(el);
  });
}

function hideReplayList() {
  document.getElementById('replay-list').style.display = 'none';
}

function startReplayLocal(idx) {
  const records = JSON.parse(localStorage.getItem('goban_records') || '[]');
  if (!records[idx]) return;
  const rec = records[idx];
  replayMoves = rec.moves;
  replayIndex = -1;
  replayMode = true;
  document.getElementById('replay-list').style.display = 'none';

  document.getElementById('replay-controls').style.display = '';
  document.getElementById('match-btn').disabled = true;
  document.getElementById('create-room-btn').disabled = true;
  document.getElementById('room-controls').style.display = 'none';

  board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  setStatus(`回放: ${rec.opponent} (${rec.result}) - 第 0 手`);
  drawBoard();
}

async function startReplayServer(gameId) {
  document.getElementById('replay-list').style.display = 'none';
  let moves = [];
  try {
    const resp = await fetch(`${httpBase}/api/games/${gameId}`);
    const data = await resp.json();
    moves = (data.moves || []).map(m => ({ x: m.x, y: m.y, color: m.color }));
  } catch(e) {
    setStatus('加载对局失败');
    return;
  }

  if (moves.length === 0) {
    setStatus('对局无落子记录');
    return;
  }

  replayMoves = moves;
  replayIndex = -1;
  replayMode = true;

  document.getElementById('replay-controls').style.display = '';
  document.getElementById('match-btn').disabled = true;
  document.getElementById('create-room-btn').disabled = true;
  document.getElementById('room-controls').style.display = 'none';

  board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  setStatus(`回放: 第 0 手 (共 ${moves.length} 手)`);
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
    if (replayIndex >= 0) {
      const prev = replayMoves[replayIndex];
      lastMove = {x: prev.x, y: prev.y};
    } else {
      lastMove = null;
    }
  }
  if (replayIndex >= 0) {
    const cur = replayMoves[replayIndex];
    const col = String.fromCharCode(65 + cur.x);
    const row = SIZE - cur.y;
    const colName = (replayMoves[replayIndex].color === 1 ? '黑' : '白');
    setStatus(`回放: 第 ${replayIndex + 1}/${replayMoves.length} 手 ${colName} ${col}${row}`);
  } else {
    setStatus(`回放: 第 0 手 (共 ${replayMoves.length} 手)`);
  }
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
  const theme = getThemeColors();
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = theme.grid;
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
  ctx.fillStyle = theme.star;
  for (const [sx, sy] of stars) {
    ctx.beginPath();
    ctx.arc(PAD + sx * CELL, PAD + sy * CELL, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pieces
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (board[y][x] !== 0) drawPiece(x, y, board[y][x], 1, theme);
    }
  }

  // Last move marker
  if (lastMove && board[lastMove.y][lastMove.x] !== 0) {
    drawLastMoveMarker(lastMove.x, lastMove.y, board[lastMove.y][lastMove.x], theme);
  }

  // Win line highlight
  if (winLine && winLine.length === 5) {
    drawWinLineHighlight(winLine, theme);
  }

  // Replay move numbers
  if (replayMode && replayIndex >= 0) {
    for (let i = 0; i <= replayIndex; i++) {
      const m = replayMoves[i];
      if (board[m.y] && board[m.y][m.x] !== 0) {
        const cx = PAD + m.x * CELL;
        const cy = PAD + m.y * CELL;
        ctx.fillStyle = board[m.y][m.x] === 1 ? '#ddd' : '#333';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i + 1, cx, cy);
      }
    }
  }

  // Coordinate labels
  ctx.fillStyle = theme.label;
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

function drawPiece(x, y, color, scale, theme) {
  const t = theme || getThemeColors();
  const cx = PAD + x * CELL;
  const cy = PAD + y * CELL;
  const r = (CELL * 0.42) * (scale || 1);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);

  if (color === 1) {
    const grad = ctx.createRadialGradient(cx - 3, cy - 3, 2, cx, cy, r);
    grad.addColorStop(0, t.black1);
    grad.addColorStop(1, t.black2);
    ctx.fillStyle = grad;
  } else {
    const grad = ctx.createRadialGradient(cx - 3, cy - 3, 2, cx, cy, r);
    grad.addColorStop(0, t.white1);
    grad.addColorStop(1, t.white2);
    ctx.fillStyle = grad;
  }
  ctx.fill();
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

function drawLastMoveMarker(x, y, color, theme) {
  const t = theme || getThemeColors();
  const cx = PAD + x * CELL;
  const cy = PAD + y * CELL;
  const r = 4;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = t.lastMove;
  ctx.fill();
}

function drawWinLineHighlight(points, theme) {
  const t = theme || getThemeColors();
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
  for (const p of points) {
    const cx = PAD + p[0] * CELL;
    const cy = PAD + p[1] * CELL;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.45, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${t.winGlow}, ${0.5 + pulse * 0.5})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.48, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${t.winGlow}, ${0.2 + pulse * 0.3})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (winLine) requestAnimationFrame(() => drawBoard());
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
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const scale = easeOut;

    drawBoard();
    const theme = getThemeColors();
    drawPiece(x, y, color, scale, theme);
    elapsed < ANIMATION_DURATION ? requestAnimationFrame(frame) : drawBoard();
  }
  requestAnimationFrame(frame);
}

// ===== Click / Touch =====
function handleCanvasInput(clientX, clientY) {
  if (!gameStarted || !myTurn || isSpectator) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // Convert CSS-pixel click position to logical drawing coordinates.
  // canvas.width = size * dpr, so dividing by dpr yields logical space.
  const px = (clientX - rect.left) * (canvas.width / rect.width) / dpr;
  const py = (clientY - rect.top) * (canvas.height / rect.height) / dpr;

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
  document.getElementById('game-actions').style.display = 'none';
  document.getElementById('rematch-actions').style.display = 'none';
  document.getElementById('undo-overlay').style.display = 'none';
  board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  winLine = null;
  currentMoves = [];
  chatMessages = [];
  document.getElementById('chat-messages').innerHTML = '';
}

// ===== Canvas Sizing (Responsive) =====
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const maxWidth = Math.min(window.innerWidth - 40, 480);
  const maxHeight = window.innerHeight - 220;
  const size = Math.min(maxWidth, maxHeight, 480);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ===== Chat toggle for mobile =====
function toggleChat() {
  const panel = document.getElementById('chat-panel');
  panel.classList.toggle('collapsed');
}

// ===== Click outside to close profile =====
document.addEventListener('click', (e) => {
  const panel = document.getElementById('profile-panel');
  const profileArea = document.getElementById('profile-area');
  if (panel.style.display !== 'none' && !panel.contains(e.target) && !profileArea.contains(e.target)) {
    panel.style.display = 'none';
  }
});

// ===== Auto-login from localStorage =====
(function init() {
  initTheme();
  document.getElementById('sound-toggle-btn').textContent = soundEnabled ? '🔊' : '🔇';
  const savedToken = localStorage.getItem('goban_token');
  const savedUsername = localStorage.getItem('goban_username');
  if (savedToken && savedUsername) {
    token = savedToken;
    username = savedUsername;
    showGameArea(username);
    connectWS();
  }
})();
