require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const redis = new Redis(process.env.REDIS_URL, { tls: { rejectUnauthorized: false } });
const subscriber = new Redis(process.env.REDIS_URL, { tls: { rejectUnauthorized: false } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'defaultsecret';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ---------- Helper Functions ----------
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ---------- User Registration & Login ----------
app.post('/api/register', async (req, res) => {
  const { username, password, referralCode, language } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Username taken' });
    const hash = await bcrypt.hash(password, 10);
    const refCode = generateReferralCode();
    let referredBy = null;
    if (referralCode) {
      const refUser = await pool.query('SELECT id FROM users WHERE referral_code=$1', [referralCode]);
      if (refUser.rows.length > 0) {
        referredBy = refUser.rows[0].id;
      }
    }
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, referral_code, referred_by, language)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [username, hash, refCode, referredBy, language || 'en']
    );
    const newUserId = result.rows[0].id;

    // Registration bonus to referrer (if any)
    if (referredBy) {
      const bonusSetting = await pool.query("SELECT value->>'registration_bonus' as bonus FROM settings WHERE key='referral'");
      const bonus = parseFloat(bonusSetting.rows[0]?.bonus || '0');
      if (bonus > 0) {
        await pool.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [bonus, referredBy]);
        await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1,'referral_bonus',$2,'approved')`, [referredBy, bonus]);
        await pool.query(`INSERT INTO referral_rewards (referrer_id, referred_user_id, reward_type, amount) VALUES ($1,$2,'registration_bonus',$3)`, [referredBy, newUserId, bonus]);
      }
    }

    const token = jwt.sign({ id: newUserId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: newUserId, referralCode: refCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await pool.query('SELECT id, password_hash FROM users WHERE username=$1', [username]);
    if (user.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.rows[0].id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---------- Balance & Profile ----------
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT id, username, balance, language, referral_code, banned FROM users WHERE id=$1', [req.user.id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(user.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Deposit / Withdraw (requests) ----------
app.post('/api/deposit', authenticateToken, async (req, res) => {
  const { amount, platform, reference } = req.body;
  if (!amount || !platform || !reference) return res.status(400).json({ error: 'Missing fields' });
  try {
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, platform, reference) VALUES ($1,'deposit',$2,$3,$4)`,
      [req.user.id, amount, platform, reference]
    );
    res.json({ message: 'Deposit request submitted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw', authenticateToken, async (req, res) => {
  const { amount, platform, account } = req.body;
  if (!amount || !platform || !account) return res.status(400).json({ error: 'Missing fields' });
  try {
    // Check min balance of 100 after withdrawal
    const user = await pool.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
    const currentBalance = parseFloat(user.rows[0].balance);
    if (currentBalance - amount < 100) {
      return res.status(400).json({ error: 'Minimum wallet balance 100 must remain' });
    }
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, platform, account_info) VALUES ($1,'withdrawal',$2,$3,$4)`,
      [req.user.id, amount, platform, account]
    );
    res.json({ message: 'Withdrawal request submitted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Join Game (WebSocket message handling) ----------
wss.on('connection', (ws) => {
  ws.userId = null;
  ws.username = null;
  ws.isAdmin = false;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      // Authenticate via token
      if (data.type === 'AUTH') {
        jwt.verify(data.token, JWT_SECRET, async (err, decoded) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Invalid token' }));
            return;
          }
          const user = await pool.query('SELECT id, username, banned FROM users WHERE id=$1', [decoded.id]);
          if (user.rows.length === 0 || user.rows[0].banned) {
            ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Banned or not found' }));
            return;
          }
          ws.userId = user.rows[0].id;
          ws.username = user.rows[0].username;
          ws.send(JSON.stringify({ type: 'AUTH_OK', userId: ws.userId, username: ws.username }));
        });
      }
      // ... handle JOIN_GAME, BUY_CARDS, CLAIM_BINGO (will be detailed in final code)
      // For brevity, I'll include the full server.js in the final answer.
    } catch (e) {
      console.error(e);
    }
  });
});

// ---------- Telegram Bot ----------
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
bot.setWebHook(`${RENDER_URL}/webhook`);

// Bot commands: /start, /balance, /join, /cards, /referral, /deposit, /withdraw, /sos
// (Implementation will be in final server.js)

// ---------- Admin API (protected by x-admin-token) ----------
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  // Return live game states from Redis
  const stakes = [10,20,50,100];
  const data = {};
  for (const s of stakes) {
    const status = await redis.get(`stake:${s}:status`) || 'waiting';
    const players = await redis.smembers(`stake:${s}:players`);
    const prize = await redis.get(`stake:${s}:prize_pool`) || 0;
    data[s] = { status, playerCount: players.length, prizePool: prize };
  }
  res.json(data);
});

app.get('/api/admin/users', requireAdmin, async (req, res) => { /* search, list */ });
app.post('/api/admin/authorize-transaction', requireAdmin, async (req, res) => { /* approve deposit/withdrawal */ });
app.post('/api/admin/ban-user', requireAdmin, async (req, res) => { /* toggle ban */ });
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => { /* send to all WebSocket clients + Telegram */ });
// ... full admin routes in final code

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
