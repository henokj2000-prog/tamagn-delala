require('dotenv').config();

const Redis = require('ioredis');
const { Pool } = require('pg');
const redis = new Redis(process.env.REDIS_URL, { tls: { rejectUnauthorized: false } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const STAKES = [10,20,50,100];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gameLoop(stake) {
  // Read settings from DB (countdown, interval, house %, bot config)
  // Implement the full loop: waiting → countdown → active → check winner → payout → reset
  // Use Redis for live state, PostgreSQL for history.
  // Publish events to 'game:events' channel.
  // (Full implementation in final code)
}

STAKES.forEach(s => gameLoop(s).catch(console.error));
