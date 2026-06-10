-- Drop old tables if they exist

DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS referral_rewards CASCADE;
DROP TABLE IF EXISTS player_cards CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS game_rounds CASCADE;
DROP TABLE IF EXISTS admins CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

-- ========== Core tables (no foreign key dependencies) ==========
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  telegram_id BIGINT UNIQUE,
  balance DECIMAL DEFAULT 0,
  language TEXT DEFAULT 'en',
  referral_code TEXT UNIQUE,
  referred_by INTEGER REFERENCES users(id),
  banned BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_super BOOLEAN DEFAULT false,
  permissions JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ========== Game rounds (must be before transactions) ==========
CREATE TABLE game_rounds (
  id SERIAL PRIMARY KEY,
  stake DECIMAL NOT NULL,
  prize_pool DECIMAL NOT NULL,
  winner_ids JSONB,
  called_numbers JSONB,
  house_share DECIMAL,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  status TEXT DEFAULT 'waiting'
);

-- ========== Transactions (now game_rounds exists) ==========
CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  type TEXT CHECK(type IN ('deposit','withdrawal','game_entry','winning','house_profit','referral_bonus','commission','bonus','refund')),
  amount DECIMAL NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  platform TEXT,
  reference TEXT,
  account_info TEXT,
  admin_id INTEGER REFERENCES admins(id),
  round_id INTEGER REFERENCES game_rounds(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ========== Player cards ==========
CREATE TABLE player_cards (
  id SERIAL PRIMARY KEY,
  round_id INTEGER REFERENCES game_rounds(id),
  user_id INTEGER REFERENCES users(id),
  is_bot BOOLEAN DEFAULT false,
  card_data JSONB NOT NULL
);

-- ========== Referral rewards ==========
CREATE TABLE referral_rewards (
  id SERIAL PRIMARY KEY,
  referrer_id INTEGER REFERENCES users(id),
  referred_user_id INTEGER REFERENCES users(id),
  reward_type TEXT CHECK(reward_type IN ('registration_bonus','win_commission')),
  amount DECIMAL,
  round_id INTEGER REFERENCES game_rounds(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ========== Messages ==========
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  from_user_id INTEGER REFERENCES users(id),
  message_text TEXT,
  admin_reply TEXT,
  status TEXT DEFAULT 'unread' CHECK(status IN ('unread','read','replied')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ========== Settings ==========
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- ========== Default settings ==========
INSERT INTO settings (key, value) VALUES
('game', '{"countdown_seconds":30,"number_interval_ms":1500,"house_percent":20}'),
('referral', '{"commission_percent":5,"registration_bonus":0}'),
('bots', '{"enabled":false,"count":0,"target_real_players":0,"auto_withdraw":false}');
