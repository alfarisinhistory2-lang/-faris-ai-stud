// db.js — الاتصال بقاعدة Neon (PostgreSQL)
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

async function getProject(id) {
  requireUrl();
  const r = await pool.query('SELECT id, title, grade, style FROM studio_projects WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function addProject({ title, grade, style }) {
  requireUrl();
  const r = await pool.query(
    'INSERT INTO studio_projects (title, grade, style) VALUES ($1, $2, $3) RETURNING id, title, grade, style, created_at',
    [title, grade, style]
  );
  return r.rows[0];
}

async function saveBook(projectId, analysis) {
  requireUrl();
  await pool.query(
    `INSERT INTO project_books (project_id, analysis) VALUES ($1, $2)
     ON CONFLICT (project_id) DO UPDATE SET analysis = $2, updated_at = now()`,
    [projectId, analysis]
  );
}

async function getBook(projectId) {
  requireUrl();
  const r = await pool.query('SELECT analysis FROM project_books WHERE project_id = $1', [projectId]);
  return r.rows[0] ? r.rows[0].analysis : null;
}

async function saveScript(projectId, scenes) {
  requireUrl();
  await pool.query(
    `INSERT INTO project_scripts (project_id, scenes) VALUES ($1, $2)
     ON CONFLICT (project_id) DO UPDATE SET scenes = $2, updated_at = now()`,
    [projectId, JSON.stringify(scenes)]
  );
}

async function getScript(projectId) {
  requireUrl();
  const r = await pool.query('SELECT scenes FROM project_scripts WHERE project_id = $1', [projectId]);
  return r.rows[0] ? r.rows[0].scenes : null;
}

module.exports = { ping, migrate, listProjects, getProject, addProject, saveBook, getBook, saveScript, getScript };
