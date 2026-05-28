// ===== State =====
let token = '';
let username = '';   // account (login ID)
let displayName = ''; // display name
const SIZE = 15;

let ws = null;
let board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
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
let kickedOut = false;
let pendingMessages = [];  // queued messages to send after auth_ok
let autoLoginPending = false;  // true during init() auto-login, cleared on auth_ok or auth error
const MAX_RECONNECT = 8;

// Game records for replay
let gameRecords = JSON.parse(localStorage.getItem('goban_records') || '[]');
let currentMoves = [];  // moves of current game
let replayMode = false;
let replayMoves = [];
let replayIndex = -1;

const BASE_SIZE = 480;
const BASE_CELL = 30;
const BASE_PAD = 15;
const ANIMATION_DURATION = 150; // ms

let CELL = BASE_CELL;
let PAD = BASE_PAD;
let BOARD_PX = CELL * (SIZE - 1);
let SCALE = 1;  // current canvas scale factor

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
      account: document.getElementById('login-account').value.trim(),
      password: document.getElementById('login-password').value,
    });
    if (res.success) {
      kickedOut = false;
      token = res.token;
      username = res.account;
      displayName = res.display_name || res.account;
      localStorage.setItem('goban_token', token);
      localStorage.setItem('goban_account', username);
      localStorage.setItem('goban_display_name', displayName);
      showGameArea(displayName);
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
      account: document.getElementById('reg-account').value.trim(),
      display_name: document.getElementById('reg-display-name').value.trim(),
      password: document.getElementById('reg-password').value,
    });
    if (res.success) {
      showAuthMsg('注册成功，请切换到登录面板登录', true);
      switchAuthTab('login');
      document.getElementById('login-account').value = res.user.account;
    } else {
      showAuthMsg(res.error, false);
    }
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
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return await resp.json();
}

async function apiGet(path) {
  const resp = await fetch(`${httpBase}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return await resp.json();
}

// ===== Auth Tab Switch =====
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  if (tab === 'login') {
    document.querySelector('.auth-tab:first-child').classList.add('active');
    document.getElementById('auth-login').style.display = '';
    document.getElementById('auth-register').style.display = 'none';
  } else {
    document.querySelector('.auth-tab:last-child').classList.add('active');
    document.getElementById('auth-login').style.display = 'none';
    document.getElementById('auth-register').style.display = '';
  }
  document.getElementById('auth-msg').textContent = '';
}

// ===== UI Toggles =====
function showGameArea(user) {
  const name = user || 'Player';
  document.getElementById('auth-area').style.display = 'none';
  document.getElementById('game-area').style.display = 'flex';
  document.getElementById('username-display').textContent = name;
  document.getElementById('avatar').textContent = name.charAt(0).toUpperCase();
  document.getElementById('logout-btn').style.display = '';
  setStatus(`欢迎，${name}`);
}

function showAuthArea() {
  localStorage.removeItem('goban_token');
  localStorage.removeItem('goban_account');
  localStorage.removeItem('goban_display_name');
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

function handleKicked(message) {
  kickedOut = true;
  autoLoginPending = false;
  token = '';
  username = '';
  displayName = '';
  localStorage.removeItem('goban_token');
  localStorage.removeItem('goban_account');
  localStorage.removeItem('goban_display_name');

  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }

  alert(message);
  showAuthArea();
}

// ===== WebSocket =====
function connectWS() {
  if (ws) { ws.onclose = null; ws.close(); }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  console.log('[ws] connecting to', `${wsBase}/ws`, 'token preview:', token ? token.substring(0, 20) + '...' : '<empty>');
  ws = new WebSocket(`${wsBase}/ws`);
  ws.onopen = () => {
    console.log('[ws] connected, sending auth');
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'auth', token }));
  };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    console.log('[ws] closed code=' + e.code + ' reason=' + (e.reason || 'none') + ' wasClean=' + e.wasClean);
    ws = null;
    matching = false;
    if (kickedOut) return;

    // Auto-login: limit reconnect attempts and show status in auth area
    if (autoLoginPending) {
      if (reconnectAttempts >= 3) {
        console.log('[ws] auto-login reconnect limit reached, giving up');
        autoLoginPending = false;
        localStorage.removeItem('goban_token');
        localStorage.removeItem('goban_account');
        reconnectAttempts = 0;
        const msgEl = document.getElementById('auth-msg');
        if (msgEl) { msgEl.textContent = '无法连接到服务器，请检查网络后重试'; msgEl.className = ''; }
        showAuthArea();
        return;
      }
      reconnectAttempts++;
      const delay = Math.min(8000, 500 * Math.pow(2, reconnectAttempts)) + Math.random() * 500;
      console.log('[ws] auto-login reconnect attempt', reconnectAttempts, '/3 delay=', Math.round(delay));
      const msgEl = document.getElementById('auth-msg');
      if (msgEl) { msgEl.textContent = `正在连接服务器(${reconnectAttempts}/3)...`; msgEl.className = ''; }
      reconnectTimer = setTimeout(() => {
        if (!ws && localStorage.getItem('goban_token')) connectWS();
      }, delay);
      return;
    }

    if (reconnectAttempts >= MAX_RECONNECT) {
      console.log('[ws] max reconnect attempts reached, giving up');
      setStatus('连接失败，请刷新页面重试');
      reconnectAttempts = 0;
      return;
    }
    if (gameStarted || roomId) {
      reconnectAttempts++;
      const delay = Math.min(10000, 1000 * Math.pow(2, reconnectAttempts))
                    + Math.random() * 1000;
      console.log('[ws] reconnect attempt', reconnectAttempts, '/', MAX_RECONNECT, 'delay=', Math.round(delay));
      setStatus(`连接断开，${Math.round(delay/1000)}秒后重连(${reconnectAttempts}/${MAX_RECONNECT})...`);
      reconnectTimer = setTimeout(() => {
        if (localStorage.getItem('goban_token')) connectWS();
      }, delay);
    } else if (localStorage.getItem('goban_token')) {
      reconnectAttempts++;
      const delay = Math.min(10000, 1000 * Math.pow(2, reconnectAttempts))
                    + Math.random() * 500;
      console.log('[ws] reconnect attempt', reconnectAttempts, '/', MAX_RECONNECT, 'delay=', Math.round(delay));
      setStatus(`连接断开，正在重连(${reconnectAttempts}/${MAX_RECONNECT})...`);
      reconnectTimer = setTimeout(() => {
        if (!ws && localStorage.getItem('goban_token')) connectWS();
      }, delay);
    }
  };
  ws.onerror = (e) => { console.log('[ws] error event', e); };
}

function handleMessage(data) {
  switch (data.type) {
    case 'auth_ok':
      console.log('[auth_ok] received, display_name:', data.display_name, 'username:', data.username);
      if (data.display_name) {
        displayName = data.display_name;
        localStorage.setItem('goban_display_name', displayName);
      }
      if (autoLoginPending) {
        autoLoginPending = false;
        showGameArea(displayName || username);
      }
      document.getElementById('username-display').textContent = displayName || username;
      document.getElementById('avatar').textContent = (displayName || username).charAt(0).toUpperCase();
      setStatus('已连接，准备就绪');
      // Flush any queued messages BEFORE resetGameState (which clears the queue)
      const queued = pendingMessages.splice(0);
      resetGameState();
      drawBoard();
      for (const msg of queued) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }
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
      winLine = null;
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
      if (data.winner === displayName) {
        playWinSound();
      } else if (data.winner !== '平局') {
        playLoseSound();
      }
      if (data.moves) {
        currentMoves = data.moves;
      }
      if (currentMoves.length > 0 && !isSpectator) {
        const opponent = roomPlayers.find(p => p && p !== displayName) || '对手';
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
      if (data.error && (data.error.includes('Token') || data.error.includes('认证') || data.error.includes('会话'))) {
        console.log('[error] auth failure detected:', data.error, '- clearing localStorage and showing auth area');
        autoLoginPending = false;
        localStorage.removeItem('goban_token');
        localStorage.removeItem('goban_account');
        showAuthArea();
        return;
      }
      console.log('[error]', data.error);
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

    case 'kicked':
      handleKicked(data.message || '账号在其他设备登录');
      return;
  }
}

function sendOrQueue(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(msg);
  } else {
    pendingMessages.push(msg);
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWS();
    }
  }
}

// ===== Room System =====
function createRoom() {
  document.getElementById('room-visibility-overlay').style.display = 'flex';
}

function confirmCreateRoom(isPublic) {
  document.getElementById('room-visibility-overlay').style.display = 'none';
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    sendOrQueue(JSON.stringify({ type: 'create_room', is_public: isPublic }));
    return;
  }
  ws.send(JSON.stringify({ type: 'create_room', is_public: isPublic }));
  setStatus(isPublic ? '正在创建公开房间...' : '正在创建私人房间...');
  document.getElementById('create-room-btn').disabled = true;
  document.getElementById('match-btn').disabled = true;
}

function cancelCreateRoom() {
  document.getElementById('room-visibility-overlay').style.display = 'none';
}

function joinRoom() {
  const input = document.getElementById('room-code-input');
  const code = input.value.trim().toUpperCase();
  if (!code || code.length < 4) {
    setStatus('请输入4位房间码');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    sendOrQueue(JSON.stringify({ type: 'join_room', room_id: code }));
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
    sendOrQueue(JSON.stringify({ type: 'join_room', room_id: code, as_spectator: true }));
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
    sendOrQueue(JSON.stringify({ type: 'match' }));
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
    document.querySelector('.profile-name').textContent = displayName;
    document.querySelector('.profile-avatar-large').textContent = displayName.charAt(0).toUpperCase();
    document.getElementById('profile-name-input').value = displayName;
    document.querySelector('.profile-edit-name').style.display = 'none';
    try {
      const data = await apiGet(`/api/profile?account=${encodeURIComponent(username)}`);
      document.getElementById('stat-total').textContent = data.total_games || 0;
      document.getElementById('stat-wins').textContent = data.wins || 0;
      const rate = data.total_games > 0 ? Math.round((data.wins / data.total_games) * 100) + '%' : '-';
      document.getElementById('stat-rate').textContent = rate;
    } catch(e) {
      document.getElementById('stat-total').textContent = '0';
      document.getElementById('stat-wins').textContent = '0';
      document.getElementById('stat-rate').textContent = '-';
    }
  } else {
    panel.style.display = 'none';
    document.querySelector('.profile-edit-name').style.display = 'none';
  }
}

function startEditName() {
  document.getElementById('profile-name-input').value = displayName;
  document.querySelector('.profile-edit-name').style.display = '';
}

function cancelEditName() {
  document.querySelector('.profile-edit-name').style.display = 'none';
  document.getElementById('profile-name-msg').textContent = '';
}

async function saveDisplayName() {
  const input = document.getElementById('profile-name-input');
  const newName = input.value.trim();
  if (!newName || newName.length < 2 || newName.length > 20) {
    document.getElementById('profile-name-msg').textContent = '用户名需2-20个字符';
    document.getElementById('profile-name-msg').style.color = '#ff6b6b';
    return;
  }
  try {
    const data = await apiPost('/api/profile/update', { display_name: newName });
    if (data.success) {
      displayName = newName;
      localStorage.setItem('goban_display_name', displayName);
      document.querySelector('.profile-name').textContent = displayName;
      document.querySelector('.profile-avatar-large').textContent = displayName.charAt(0).toUpperCase();
      document.getElementById('username-display').textContent = displayName;
      document.getElementById('avatar').textContent = displayName.charAt(0).toUpperCase();
      document.querySelector('.profile-edit-name').style.display = 'none';
      document.getElementById('profile-name-msg').textContent = '';
    } else {
      document.getElementById('profile-name-msg').textContent = data.error || '修改失败';
      document.getElementById('profile-name-msg').style.color = '#ff6b6b';
    }
  } catch(e) {
    document.getElementById('profile-name-msg').textContent = '网络错误';
    document.getElementById('profile-name-msg').style.color = '#ff6b6b';
  }
}

function doLogout() {
  localStorage.removeItem('goban_token');
  localStorage.removeItem('goban_account');
  localStorage.removeItem('goban_display_name');
  document.getElementById('profile-panel').style.display = 'none';
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
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
    list.innerHTML = '<div class="replay-empty">暂无可用房间</div>';
  } else {
    roomBrowserRooms.forEach(r => {
      const isPlaying = r.state === 'playing';
      const isPublic = r.is_public !== false;
      const el = document.createElement('div');
      el.className = 'room-browser-item';

      const codeSpan = document.createElement('span');
      codeSpan.className = 'room-browser-code';
      codeSpan.textContent = r.room_id;

      const playerStr = (r.players || [r.creator]).join(' vs ');
      const creatorSpan = document.createElement('span');
      creatorSpan.className = 'room-browser-creator';
      creatorSpan.title = playerStr;
      creatorSpan.textContent = playerStr;

      const badge = document.createElement('span');
      badge.className = 'room-browser-badge ' + (isPlaying ? 'playing' : 'waiting');
      badge.textContent = isPlaying ? '对战中' : '等待中';

      el.appendChild(codeSpan);
      el.appendChild(creatorSpan);
      el.appendChild(badge);

      if (r.spectator_count > 0) {
        const specSpan = document.createElement('span');
        specSpan.className = 'room-browser-spec';
        specSpan.textContent = '👁 ' + r.spectator_count;
        el.appendChild(specSpan);
      }

      const visBadge = document.createElement('span');
      visBadge.className = 'room-browser-vis';
      visBadge.textContent = isPublic ? '🌐' : '🔒 私人';
      el.appendChild(visBadge);

      if (isPublic) {
        const actionBtn = document.createElement('button');
        actionBtn.className = 'btn-small ' + (isPlaying ? 'room-browser-spectate' : 'room-browser-join');
        actionBtn.textContent = isPlaying ? '观战' : '加入';
        actionBtn.onclick = () => {
          if (isPlaying) {
            document.getElementById('spectate-code-input').value = r.room_id;
            hideRoomBrowser();
            spectateRoom();
          } else {
            document.getElementById('room-code-input').value = r.room_id;
            hideRoomBrowser();
            joinRoom();
          }
        };
        el.appendChild(actionBtn);
      }

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
    ? `<span class="chat-system">${escapeHtml(msg)}</span>`
    : `<span class="chat-user">${escapeHtml(user)}:</span> <span class="chat-text">${escapeHtml(msg)}</span>`;
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
    const data = await apiGet(`/api/games?username=${encodeURIComponent(username)}`);
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

        const infoSpan = document.createElement('span');
        infoSpan.className = 'replay-info';
        infoSpan.textContent = `${dateStr} vs ${rec.opponent}`;

        const resultSpan = document.createElement('span');
        resultSpan.className = 'replay-result';
        resultSpan.textContent = rec.result;

        const btn = document.createElement('button');
        btn.textContent = '回放';
        btn.onclick = () => { hideReplayList(); startReplayLocal(idx); };

        el.appendChild(infoSpan);
        el.appendChild(resultSpan);
        el.appendChild(btn);
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

    const infoSpan = document.createElement('span');
    infoSpan.className = 'replay-info';
    infoSpan.textContent = `${dateStr} vs ${opp || '未知'}`;

    const resultSpan = document.createElement('span');
    resultSpan.className = 'replay-result';
    resultSpan.textContent = g.winner;

    const btn = document.createElement('button');
    btn.textContent = '回放';
    btn.onclick = () => { hideReplayList(); startReplayServer(g.id); };

    el.appendChild(infoSpan);
    el.appendChild(resultSpan);
    el.appendChild(btn);
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
    const data = await apiGet(`/api/games/${gameId}`);
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
  ctx.lineWidth = Math.max(0.5, SCALE);
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
  const starR = 3 * SCALE;
  for (const [sx, sy] of stars) {
    ctx.beginPath();
    ctx.arc(PAD + sx * CELL, PAD + sy * CELL, starR, 0, Math.PI * 2);
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
        ctx.font = `bold ${Math.max(7, 10 * SCALE)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i + 1, cx, cy);
      }
    }
  }

  // Coordinate labels
  ctx.fillStyle = theme.label;
  ctx.font = `${Math.max(7, 10 * SCALE)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelOffset = Math.max(2, PAD * 0.13);
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String.fromCharCode(65 + i), PAD + i * CELL, labelOffset);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String(SIZE - i), labelOffset, PAD + i * CELL);
  }
}

function drawPiece(x, y, color, scale, theme) {
  const t = theme || getThemeColors();
  const cx = PAD + x * CELL;
  const cy = PAD + y * CELL;
  const r = (CELL * 0.42) * (scale || 1);
  const go = 3 * SCALE;  // gradient offset

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);

  if (color === 1) {
    const grad = ctx.createRadialGradient(cx - go, cy - go, go * 0.7, cx, cy, r);
    grad.addColorStop(0, t.black1);
    grad.addColorStop(1, t.black2);
    ctx.fillStyle = grad;
  } else {
    const grad = ctx.createRadialGradient(cx - go, cy - go, go * 0.7, cx, cy, r);
    grad.addColorStop(0, t.white1);
    grad.addColorStop(1, t.white2);
    ctx.fillStyle = grad;
  }
  ctx.fill();
  ctx.strokeStyle = '#333';
  ctx.lineWidth = Math.max(0.3, 0.5 * SCALE);
  ctx.stroke();
}

function drawLastMoveMarker(x, y, color, theme) {
  const t = theme || getThemeColors();
  const cx = PAD + x * CELL;
  const cy = PAD + y * CELL;
  const r = 4 * SCALE;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = t.lastMove;
  ctx.fill();
}

function drawWinLineHighlight(points, theme) {
  const t = theme || getThemeColors();
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
  const lw1 = Math.max(1.5, 3 * SCALE);
  const lw2 = Math.max(1, 2 * SCALE);
  for (const p of points) {
    const cx = PAD + p[0] * CELL;
    const cy = PAD + p[1] * CELL;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.45, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${t.winGlow}, ${0.5 + pulse * 0.5})`;
    ctx.lineWidth = lw1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.48, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${t.winGlow}, ${0.2 + pulse * 0.3})`;
    ctx.lineWidth = lw2;
    ctx.stroke();
  }
  if (winLine) requestAnimationFrame(() => drawBoard());
}

function animatePiece(x, y, color) {
  let start = null;

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

  const snapRadius = CELL * 0.48;  // slightly less than half-cell for better UX
  if (bestDist > snapRadius * snapRadius || board[by][bx] !== 0) return;

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
  roomId = '';
  replayMode = false;
  replayMoves = [];
  replayIndex = -1;
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
  document.getElementById('replay-controls').style.display = 'none';
  board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  winLine = null;
  currentMoves = [];
  chatMessages = [];
  document.getElementById('chat-messages').innerHTML = '';
  pendingMessages = [];
}

// ===== Canvas Sizing (Responsive) =====
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const isMobile = window.innerWidth <= 700;

  // Horizontal: full width minus side padding
  const hPad = isMobile ? 20 : 40;
  const maxW = Math.min(window.innerWidth - hPad, BASE_SIZE);

  // Vertical: measure actual UI elements
  const bodyPad = isMobile ? 8 : 16;
  const headerEl = document.querySelector('.game-header');
  const headerH = headerEl ? headerEl.offsetHeight : 44;
  const roomEl = document.getElementById('room-info');
  const roomH = (roomEl && roomEl.style.display !== 'none') ? roomEl.offsetHeight : 0;
  const actionsEl = document.getElementById('game-actions');
  const rematchEl = document.getElementById('rematch-actions');
  const actionsH = Math.max(
    (actionsEl && actionsEl.style.display !== 'none') ? actionsEl.offsetHeight : 0,
    (rematchEl && rematchEl.style.display !== 'none') ? rematchEl.offsetHeight : 0
  );
  // On mobile, reserve minimal space for side-panel controls so they're discoverable
  const belowBoard = isMobile ? 130 : 0;
  const usedV = bodyPad + headerH + roomH + actionsH + belowBoard + 16;
  const maxH = Math.min(window.innerHeight - usedV, BASE_SIZE);

  const size = Math.max(220, Math.min(maxW, maxH, BASE_SIZE));

  // Scale board constants proportionally
  const s = size / BASE_SIZE;
  SCALE = s;
  CELL = BASE_CELL * s;
  PAD = BASE_PAD * s;
  BOARD_PX = CELL * (SIZE - 1);

  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  drawBoard();
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
  const savedAccount = localStorage.getItem('goban_account');
  console.log('[init] savedToken:', savedToken ? savedToken.substring(0, 30) + '...' : '<none>',
              'savedAccount:', savedAccount || '<none>');
  if (savedToken && savedAccount) {
    kickedOut = false;
    token = savedToken;
    username = savedAccount;
    displayName = localStorage.getItem('goban_display_name') || savedAccount;
    console.log('[init] auto-login with saved token, username:', username);
    autoLoginPending = true;
    const msgEl = document.getElementById('auth-msg');
    if (msgEl) { msgEl.textContent = '正在自动登录...'; msgEl.className = ''; }
    connectWS();
  } else {
    console.log('[init] no saved token, showing auth area');
  }
})();
