const express = require('express');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(['/api', '/health'], (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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

app.get('/api/projects/:id/book', async (req, res) => {
  try { res.json(await db.getBook(+req.params.id)); } catch (e) { fail500(res, e); }
});

app.post('/api/projects/:id/book', async (req, res) => {
  try {
    const images = (req.body && req.body.images) || [];
    if (!images.length || images.length > 8) return res.status(400).json({ error: 'images 1-8' });
    if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'no gemini key' });

    const prompt = 'أنت معلم تاريخ سوداني. حلّل صفحات الدرس المرفقة وأعد JSON فقط بالشكل: ' +
      '{"title":"","summary":"ملخص بسيط","points":["نقاط رئيسية"],"people":["شخصيات"],"dates":["تواريخ وأحداث"],"places":["أماكن"],"questions":["أسئلة تقويم"]}';
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, ...images.map(d => ({ inline_data: typeof d === 'string' ? { mime_type: 'image/jpeg', data: d } : { mime_type: d.mime, data: d.data } }))] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
    const j = await r.json();
    if (!r.ok) { console.error('gemini:', JSON.stringify(j).slice(0, 300)); return res.status(502).json({ error: 'gemini' }); }
    const analysis = JSON.parse(j.candidates[0].content.parts[0].text);
    await db.saveBook(+req.params.id, analysis);
    res.json(analysis);
  } catch (e) { fail500(res, e); }
});

db.migrate().then(() => console.log('migrations ok')).catch(e => console.error('migrate:', e.message));

app.listen(PORT, () => console.log('Faris Studio on ' + PORT));
