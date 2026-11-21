// settings-routes.js — مسارات صفحة "الإعدادات" في فارس ستوديو
// الاستخدام في server.js (بعد express.json()):
//   require('./settings-routes')(app);
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

async function testDb() {
  const p = getPool();
  if (!p) return { ok: false, msg: 'DATABASE_URL غير مضاف في Render' };
  try {
    await p.query('SELECT 1');
    return { ok: true, msg: 'قاعدة البيانات متصلة' };
  } catch (e) {
    return { ok: false, msg: 'فشل الاتصال بـ Neon: ' + e.message };
  }
}

async function testGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, msg: 'GEMINI_API_KEY غير مضاف في Render' };
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + key
    );
    return r.ok
      ? { ok: true, msg: 'مفتاح Gemini يعمل' }
      : { ok: false, msg: 'Gemini رفض المفتاح (HTTP ' + r.status + ')' };
  } catch (e) {
    return { ok: false, msg: 'تعذّر الوصول إلى Gemini: ' + e.message };
  }
}

async function runMigrations() {
  const p = getPool();
  if (!p) return { ok: false, msg: 'DATABASE_URL غير مضاف' };
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir))
    return { ok: false, msg: 'لا يوجد مجلد migrations في المستودع' };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  if (!files.length) return { ok: false, msg: 'مجلد migrations فارغ' };
  try {
    for (const f of files) {
      await p.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    return { ok: true, msg: 'تم تشغيل ' + files.length + ' ملف هجرة' };
  } catch (e) {
    return { ok: false, msg: 'فشلت الهجرة: ' + e.message };
  }
}

module.exports = function (app) {
  // حالة سريعة بدون كشف أي مفتاح
  app.get(['/api/settings/status', '/api/settings'], (req, res) => {
    res.json({
      ok: true,
      env: {
        DATABASE_URL: !!process.env.DATABASE_URL,
        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      },
    });
  });

  // زر "اختبار الاتصالات"
  app.all(['/api/settings/test', '/api/test-connections'], async (req, res) => {
    const [db, gemini] = await Promise.all([testDb(), testGemini()]);
    res.json({ ok: db.ok && gemini.ok, db, gemini });
  });

  // زر "تشغيل الهجرات"
  app.post(['/api/settings/migrate', '/api/migrate'], async (req, res) => {
    res.json(await runMigrations());
  });
};
