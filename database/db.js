const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
const poolConfig = databaseUrl
  ? { connectionString: databaseUrl }
  : {
      host: process.env.TIMESCALEDB_HOST || 'localhost',
      port: Number(process.env.TIMESCALEDB_PORT || 5433),
      database: process.env.TIMESCALEDB_DATABASE || 'hydrosync',
      user: process.env.TIMESCALEDB_USER || 'hydrosync',
      password: process.env.TIMESCALEDB_PASSWORD || 'hydrosync_dev_password',
    };

poolConfig.statement_timeout = 2000;
poolConfig.query_timeout = 2000;

if (databaseUrl && process.env.DATABASE_SSL !== 'false') {
  poolConfig.ssl = {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
    ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA } : {})
  };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected TimescaleDB pool error:', err);
});

module.exports = pool;
