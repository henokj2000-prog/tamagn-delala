// ==================== GLOBAL STATE ====================
let token = localStorage.getItem('token');
let currentUser = null;
let ws = null;
let selectedStake = null;
let myCards = [];
let gameStatus = 'waiting'; // waiting|countdown|active|ended
let countdownInterval = null;
let calledNumbers = [];
let currentLanguage = localStorage.getItem('language') || 'en';
let translations = {};

// Admin state
let adminToken = localStorage.getItem('adminToken');

// ==================== DOM ELEMENTS ====================
const screens = {
  auth: document.getElementById('auth-screen'),
  game: document.getElementById('game-screen'),
  admin: document.getElementById('admin-screen')
};

const authForms = {
  login: document.getElementById('login-form'),
  register: document.getElementById('register-form')
};

const lobbyView = document.getElementById('lobby-view');
const gameView = document.getElementById('game-view');
const winnerOverlay = document.getElementById('winner-overlay');
const modalOverlay = document.getElementById('modal-overlay');

// ==================== LANGUAGE LOADING ====================
async function loadLanguage(lang) {
  try {
    const res = await fetch(`/locales/${lang}.json`);
    if (!res.ok) throw new Error('Failed to load');
    translations = await res.json();
    applyTranslations();
    localStorage.setItem('language', lang);
    currentLanguage = lang;
    document.getElementById('lang-select').value = lang;
  } catch (err) {
    console.error('Language load error', err);
    // fallback to English
    if (lang !== 'en') {
      loadLanguage('en');
    }
  }
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (translations[key]) {
      if (el.tagName === 'INPUT' && el.type === 'submit') {
        el.value = translations[key];
      } else if (el.tagName === 'INPUT') {
        el.placeholder = translations[key];
      } else {
        el.textContent = translations[key];
      }
    }
  });
  // Update dynamic texts
  if (currentUser && !screens.game.classList.contains('active')) {
    document.getElementById('balance-amount').textContent = currentUser.balance;
  }
}

// ==================== SCREEN SWITCHING ====================
function showScreen(screenId) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

// ==================== AUTH ====================
async function login(username, password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  token = data.token;
  localStorage.setItem('token', token);
  await fetchProfile();
}

async function register(username, password, confirm, referralCode) {
  if (password !== confirm) throw new Error('Passwords do not match');
  const body = { username, password, language: currentLanguage };
  if (referralCode) body.referralCode = referralCode;
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  token = data.token;
  localStorage.setItem('token', token);
  await fetchProfile();
}

async function fetchProfile() {
  const res = await fetch('/api/profile', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Session expired');
  currentUser = await res.json();
  if (currentUser.language && currentUser.language !== currentLanguage) {
    await loadLanguage(currentUser.language);
  }
  showScreen('game-screen');
  document.getElementById('balance-amount').textContent = currentUser.balance;
  connectWebSocket();
}

// ==================== WEBSOCKET ====================
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'AUTH', token }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleSocketMessage(data);
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 3000); // reconnect
  };
}

function handleSocketMessage(data) {
  switch (data.type) {
    case 'AUTH_OK':
      // authorized
      break;
    case 'AUTH_ERROR':
      alert(data.message);
      logout();
      break;
    case 'CURRENT_STATE':
      // not used much; we rely on game events
      break;
    case 'GAME_STATE_UPDATE':
      updateGameState(data);
      break;
    case 'CARD_ASSIGNED':
      myCards = data.cards;
      renderCards();
      break;
    case 'COUNTDOWN_START':
      startCountdown(data.seconds);
      break;
    case 'GAME_ACTIVE':
      gameActive();
      break;
    case 'NUMBER_CALLED':
      handleNumberCalled(data.number);
      break;
    case 'GAME_ENDED':
      showWinner(data);
      break;
    case 'ERROR':
      alert(data.message);
      break;
    default:
      break;
  }
}

// ==================== GAME LOGIC ====================
function updateGameState(state) {
  gameStatus = state.status;
  const playerCount = document.getElementById('player-count');
  const prizePool = document.getElementById('prize-pool');
  if (state.players) playerCount.textContent = state.players;
  if (state.prizePool) prizePool.textContent = state.prizePool;
  const statusText = document.getElementById('game-status-text');
  statusText.textContent = state.statusText || '';
  if (state.status === 'active') {
    gameView.classList.add('active');
    lobbyView.classList.remove('active');
  } else {
    gameView.classList.remove('active');
    lobbyView.classList.add('active');
  }
}

function joinStake(stake) {
  selectedStake = stake;
  document.querySelectorAll('.stake-btn').forEach(btn => btn.classList.remove('selected'));
  document.querySelector(`.stake-btn[data-stake="${stake}"]`).classList.add('selected');
  // Enable buy cards
  document.getElementById('card-count').disabled = false;
  document.getElementById('buy-cards-btn').disabled = false;
}

function buyCards() {
  const count = parseInt(document.getElementById('card-count').value);
  if (!selectedStake) return alert('Select a stake first');
  if (count < 1 || count > 4) return alert('Invalid card count');
  ws.send(JSON.stringify({
    type: 'BUY_CARDS',
    stake: selectedStake,
    count
  }));
}

function startCountdown(seconds) {
  clearInterval(countdownInterval);
  document.getElementById('countdown-timer').classList.remove('hidden');
  document.getElementById('game-view').classList.add('active');
  lobbyView.classList.remove('active');
  const display = document.getElementById('countdown-seconds');
  let remaining = seconds;
  display.textContent = remaining;
  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      document.getElementById('countdown-timer').classList.add('hidden');
    } else {
      display.textContent = remaining;
    }
  }, 1000);
}

function gameActive() {
  clearInterval(countdownInterval);
  document.getElementById('countdown-timer').classList.add('hidden');
  document.getElementById('active-game').classList.remove('hidden');
  document.getElementById('bingo-claim-btn').classList.remove('hidden');
}

function handleNumberCalled(number) {
  calledNumbers.push(number);
  const container = document.getElementById('called-numbers-container');
  const ball = document.createElement('div');
  ball.className = 'called-ball';
  ball.textContent = number;
  container.appendChild(ball);
  // auto-mark cards
  document.querySelectorAll('.bingo-card td').forEach(cell => {
    if (cell.dataset.number == number) cell.classList.add('marked');
  });
}

function renderCards() {
  const container = document.getElementById('bingo-cards-container');
  container.innerHTML = '';
  myCards.forEach((card, index) => {
    const cardDiv = document.createElement('div');
    cardDiv.className = 'bingo-card';
    let table = '<table><tr><th>B</th><th>I</th><th>N</th><th>G</th><th>O</th></tr>';
    for (let r = 0; r < 5; r++) {
      table += '<tr>';
      for (let c = 0; c < 5; c++) {
        const num = card[c].numbers[r];
        const display = num === 'FREE' ? '⭐' : num;
        const cls = num === 'FREE' ? 'free' : '';
        table += `<td class="${cls}" data-number="${num === 'FREE' ? 'FREE' : num}">${display}</td>`;
      }
      table += '</tr>';
    }
    table += '</table>';
    cardDiv.innerHTML = table;
    container.appendChild(cardDiv);
  });
}

function claimBingo() {
  ws.send(JSON.stringify({ type: 'CLAIM_BINGO' }));
}

function showWinner(data) {
  const overlay = document.getElementById('winner-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('winner-info').textContent = data.winnerName
    ? `${data.winnerName} wins ${data.prize} birr!`
    : 'Game ended. No winner.';
  const countdownEl = document.getElementById('next-game-countdown');
  let sec = 5;
  countdownEl.textContent = `Next game in ${sec}...`;
  const interval = setInterval(() => {
    sec--;
    if (sec <= 0) {
      clearInterval(interval);
      overlay.classList.add('hidden');
      resetGameUI();
    } else {
      countdownEl.textContent = `Next game in ${sec}...`;
    }
  }, 1000);
}

function resetGameUI() {
  calledNumbers = [];
  document.getElementById('called-numbers-container').innerHTML = '';
  document.getElementById('bingo-cards-container').innerHTML = '';
  document.getElementById('bingo-claim-btn').classList.add('hidden');
  gameView.classList.remove('active');
  lobbyView.classList.add('active');
  myCards = [];
}

// ==================== MODALS ====================
function showModal(contentHtml) {
  document.getElementById('modal-content').innerHTML = contentHtml;
  modalOverlay.classList.remove('hidden');
}

function hideModal() {
  modalOverlay.classList.add('hidden');
}

// Deposit modal
function openDeposit() {
  const html = `
    <h3 data-i18n="deposit">Deposit</h3>
    <input type="number" id="dep-amount" placeholder="${t('amount')}" min="1">
    <select id="dep-platform">
      <option>Telebirr</option>
      <option>CBE</option>
      <option>M-PESA</option>
    </select>
    <input type="text" id="dep-ref" placeholder="${t('reference_number')}">
    <button class="btn green" onclick="submitDeposit()">${t('submit')}</button>
    <button class="btn" onclick="hideModal()">${t('cancel')}</button>
  `;
  showModal(html);
}

function submitDeposit() {
  const amount = document.getElementById('dep-amount').value;
  const platform = document.getElementById('dep-platform').value;
  const reference = document.getElementById('dep-ref').value;
  fetch('/api/deposit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ amount, platform, reference })
  }).then(res => res.json())
    .then(data => {
      alert(data.message);
      hideModal();
    });
}

// Withdraw modal
function openWithdraw() {
  const html = `
    <h3 data-i18n="withdraw">Withdraw</h3>
    <input type="number" id="wit-amount" placeholder="${t('amount')}" min="1">
    <select id="wit-platform">
      <option>Telebirr</option>
      <option>CBE</option>
      <option>M-PESA</option>
    </select>
    <input type="text" id="wit-account" placeholder="${t('account_phone')}">
    <button class="btn red" onclick="submitWithdraw()">${t('submit')}</button>
    <button class="btn" onclick="hideModal()">${t('cancel')}</button>
  `;
  showModal(html);
}

function submitWithdraw() {
  const amount = document.getElementById('wit-amount').value;
  const platform = document.getElementById('wit-platform').value;
  const account = document.getElementById('wit-account').value;
  fetch('/api/withdraw', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ amount, platform, account })
  }).then(res => res.json())
    .then(data => {
      if (res.ok) alert(data.message);
      else alert(data.error);
      hideModal();
    });
}

// SOS
function openSOS() {
  const html = `
    <h3>Send SOS to Admin</h3>
    <textarea id="sos-text" rows="3" placeholder="Describe your problem..."></textarea>
    <button class="btn red" onclick="sendSOS()">Send</button>
    <button class="btn" onclick="hideModal()">Cancel</button>
  `;
  showModal(html);
}

function sendSOS() {
  const text = document.getElementById('sos-text').value;
  fetch('/api/sos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ message: text })
  }).then(res => res.json())
    .then(data => {
      alert(data.message);
      hideModal();
    });
}

// ==================== ADMIN PANEL ====================
function showAdminLogin() {
  if (!adminToken) {
    document.getElementById('admin-content').innerHTML = `
      <h3>Admin Login</h3>
      <input type="password" id="admin-pass" placeholder="Admin password">
      <button class="btn orange" onclick="adminLogin()">Login</button>
    `;
  } else {
    loadAdminDashboard();
  }
}

function adminLogin() {
  const pass = document.getElementById('admin-pass').value;
  // Super admin password
  if (pass) {
    adminToken = pass; // the server expects x-admin-token = ADMIN_PASSWORD
    localStorage.setItem('adminToken', pass);
    loadAdminDashboard();
  }
}

async function loadAdminDashboard() {
  try {
    const res = await fetch('/api/admin/dashboard', {
      headers: { 'x-admin-token': adminToken }
    });
    if (!res.ok) throw new Error('Forbidden');
    const data = await res.json();
    let html = '<h3>Active Games</h3>';
    for (let stake in data) {
      const g = data[stake];
      html += `<p><b>Stake ${stake}:</b> ${g.status} | Players: ${g.playerCount} | Prize: ${g.prizePool}</p>`;
    }
    html += '<button class="btn red" onclick="forceStopGame()">Force Stop (All)</button>';
    document.getElementById('admin-content').innerHTML = html;
  } catch (err) {
    alert('Admin auth failed');
    adminToken = null;
    localStorage.removeItem('adminToken');
  }
}

function forceStopGame() {
  if (!confirm('Force stop all games? Entry fees will be refunded.')) return;
  fetch('/api/admin/force-stop', {
    method: 'POST',
    headers: { 'x-admin-token': adminToken }
  }).then(() => alert('Done'));
}

// Admin tab switching
function switchAdminTab(tab) {
  // not fully implemented here, but can be added per your needs
}

// ==================== EVENT LISTENERS ====================
document.addEventListener('DOMContentLoaded', () => {
  // Language select
  document.getElementById('lang-select').addEventListener('change', (e) => {
    loadLanguage(e.target.value);
  });

  // Auth forms toggle
  document.getElementById('show-register').addEventListener('click', (e) => {
    e.preventDefault();
    authForms.login.style.display = 'none';
    authForms.register.style.display = 'block';
  });
  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    authForms.register.style.display = 'none';
    authForms.login.style.display = 'block';
  });

  authForms.login.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('login-username').value;
    const p = document.getElementById('login-password').value;
    try { await login(u, p); } catch (err) { alert(err.message); }
  });

  authForms.register.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('reg-username').value;
    const p = document.getElementById('reg-password').value;
    const c = document.getElementById('reg-confirm').value;
    const ref = document.getElementById('reg-referral').value;
    try { await register(u, p, c, ref); } catch (err) { alert(err.message); }
  });

  // Game UI buttons
  document.querySelectorAll('.stake-btn').forEach(btn => {
    btn.addEventListener('click', () => joinStake(parseInt(btn.dataset.stake)));
  });
  document.getElementById('buy-cards-btn').addEventListener('click', buyCards);
  document.getElementById('bingo-claim-btn').addEventListener('click', claimBingo);

  document.getElementById('home-btn').addEventListener('click', () => {
    lobbyView.classList.add('active');
    gameView.classList.remove('active');
  });
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Bottom menu
  document.getElementById('menu-deposit').addEventListener('click', openDeposit);
  document.getElementById('menu-withdraw').addEventListener('click', openWithdraw);
  document.getElementById('menu-sos').addEventListener('click', openSOS);
  document.getElementById('menu-referral').addEventListener('click', () => {
    alert(`Your referral code: ${currentUser.referral_code}`);
  });

  // Admin screen
  document.getElementById('admin-back-btn').addEventListener('click', () => {
    showScreen('game-screen');
  });
  // Expose admin entry: double-click logo? We'll add a secret button in the game screen.
  // For simplicity, admin can be accessed via URL hash #admin
  if (window.location.hash === '#admin') {
    showScreen('admin-screen');
    showAdminLogin();
  }
  // Also add a hidden admin button in game screen (optional)
  // Let's put a small link in the bottom menu
  const adminLink = document.createElement('button');
  adminLink.className = 'btn small';
  adminLink.textContent = 'Admin';
  adminLink.addEventListener('click', () => {
    showScreen('admin-screen');
    showAdminLogin();
  });
  document.querySelector('.bottom-menu').appendChild(adminLink);

  // Initial language load
  loadLanguage(currentLanguage);

  // If token exists, log in automatically
  if (token) {
    fetchProfile().catch(() => {
      localStorage.removeItem('token');
      token = null;
      showScreen('auth-screen');
    });
  } else {
    showScreen('auth-screen');
  }
});

function logout() {
  localStorage.removeItem('token');
  token = null;
  currentUser = null;
  if (ws) ws.close();
  showScreen('auth-screen');
}

// Helper translation function
function t(key) {
  return translations[key] || key;
}
