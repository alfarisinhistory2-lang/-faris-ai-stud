const express = require('express');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// السماح لتطبيق الهاتف (WebView) بالاتصال بالخادم
app.use(['/api', '/health'], (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// حد بسيط للكتابة: 60 طلباً في الدقيقة لكل عنوان، حمايةً من الاستهلاك الزائد
const hits = new Map();
setInterval(() => hits.clear(), 3600000);
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const now = Date.now();
  const arr = (hits.get(req.ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(req.ip, arr);
  if (arr.length > 60) return res.status(429).json({ error: 'slow down' });
  next();
});

const fail500 = (res, e) => { console.error(e.message); res.status(500).json({ error: 'server' }); };

app.get('/health', async (req, res) => {
  let ok = false;
  try { await db.ping(); ok = true; } catch {}
  res.json({ ok: true, db: ok });
});

app.get('/api/settings/status', async (req, res) => {
  let dbs;
  try { await db.ping(); dbs = { ok: true, msg: 'متصل بـ Neon' }; }
  catch { dbs = { ok: false, msg: 'تحقق من DATABASE_URL' }; }
  res.json({
    db: dbs,
    gemini: process.env.GEMINI_API_KEY ? { ok: true, msg: 'المفتاح مضبوط' } : { ok: false, msg: 'GEMINI_API_KEY غير مضبوط' },
    storage: process.env.R2_BUCKET ? { ok: true, msg: 'مضبوط' } : { ok: false, msg: 'لم يُضبط بعد (المرحلة 7)' },
  });
});

app.post('/api/settings/migrate', async (req, res) => {
  try { await db.migrate(); res.json({ ok: true }); } catch (e) { fail500(res, e); }
});

app.get('/api/projects', async (req, res) => {
  try { res.json(await db.listProjects()); } catch (e) { fail500(res, e); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { title, grade, style } = req.body || {};
    const ok = v => typeof v === 'string' && v.trim() && v.length <= 200;
    if (![title, grade, style].every(ok)) return res.status(400).json({ error: 'invalid' });
    res.json(await db.addProject({ title: title.trim(), grade, style }));
  } catch (e) { fail500(res, e); }
});

db.migrate().then(() => console.log('migrations ok')).catch(e => console.error('migrate:', e.message));
app.listen(PORT, () => console.log('Faris Studio on ' + PORT));
