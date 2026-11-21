// db.js — الاتصال بقاعدة Neon (PostgreSQL)
// الدوال المطلوبة من server.js: ping, migrate, listProjects, addProject
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

pool.on('error', (e) => console.error('pg pool:', e.message));

function requireUrl() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL غير مضبوط');
}

async function ping() {
  requireUrl();
  await pool.query('SELECT 1');
  return true;
}

async function migrate() {
  requireUrl();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS studio_projects (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      grade      TEXT NOT NULL,
      style      TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function listProjects() {
  requireUrl();
  const r = await pool.query(
    'SELECT id, title, grade, style, created_at FROM studio_projects ORDER BY id DESC LIMIT 200'
  );
  return r.rows;
}

async function addProject({ title, grade, style }) {
  requireUrl();
  const r = await pool.query(
    'INSERT INTO studio_projects (title, grade, style) VALUES ($1, $2, $3) RETURNING id, title, grade, style, created_at',
    [title, grade, style]
  );
  return r.rows[0];
}

module.exports = { ping, migrate, listProjects, addProject };
