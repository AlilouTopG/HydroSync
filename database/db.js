const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.TIMESCALEDB_HOST || 'localhost',
  port: Number(process.env.TIMESCALEDB_PORT || 5433),
  database: process.env.TIMESCALEDB_DATABASE || 'hydrosync',
  user: process.env.TIMESCALEDB_USER || 'hydrosync',
  password: process.env.TIMESCALEDB_PASSWORD || 'hydrosync_dev_password',
});

pool.on('error', (err) => {
  console.error('Unexpected TimescaleDB pool error:', err);
});

module.exports = pool;
