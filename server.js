const express = require('express');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

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

const fail500 = (res, e) => {
  console.error(e.message);
  if (e.gemini) return res.status(502).json({ error: 'gemini' });
  res.status(500).json({ error: 'server' });
};

const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.8-flash-lite'];
const sleep = ms => new Promise(s => setTimeout(s, ms));

async function gemini(parts) {
  if (!process.env.GEMINI_API_KEY) { const e = new Error('no key'); e.gemini = true; throw e; }
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } }),
        });
        const j = await r.json();
        if (r.ok) return JSON.parse(j.candidates[0].content.parts[0].text);
        console.error('gemini[' + model + ']:', JSON.stringify(j).slice(0, 200));
        if (r.status === 503) { await sleep(3000); continue; }
        break;
      } catch (e) {
        console.error('gemini[' + model + '] error:', e.message);
        await sleep(2000);
      }
    }
  }
  const e = new Error('gemini failed'); e.gemini = true; throw e;
}

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
    const prompt = 'أنت معلم تاريخ سوداني. حلّل صفحات الدرس المرفقة وأعد JSON فقط بالشكل: ' +
      '{"title":"","summary":"ملخص بسيط","points":["نقاط رئيسية"],"people":["شخصيات"],"dates":["تواريخ وأحداث"],"places":["أماكن"],"questions":["أسئلة تقويم"]}';
    const parts = [{ text: prompt }, ...images.map(d => ({
      inline_data: typeof d === 'string' ? { mime_type: 'image/jpeg', data: d } : { mime_type: d.mime, data: d.data },
    }))];
    const analysis = await gemini(parts);
    await db.saveBook(+req.params.id, analysis);
    res.json(analysis);
  } catch (e) { fail500(res, e); }
});

app.get('/api/projects/:id/script', async (req, res) => {
  try { res.json(await db.getScript(+req.params.id)); } catch (e) { fail500(res, e); }
});

app.post('/api/projects/:id/script', async (req, res) => {
  try {
    const id = +req.params.id;
    const project = await db.getProject(id);
    if (!project) return res.status(404).json({ error: 'no project' });
    const book = await db.getBook(id);
    if (!book) return res.status(400).json({ error: 'no book' });

    const prompt =
      'أنت كاتب سيناريو فيديوهات تعليمية كرتونية قصيرة لتلاميذ ' + project.grade + ' في السودان. ' +
      'الشخصية الرئيسية هي "الأستاذ فارس" معلم التاريخ. اكتب سيناريو فيديو من 6 مشاهد بالضبط عن الدرس: ' + project.title + '. ' +
      'استند فقط إلى تحليل الدرس التالي ولا تضف معلومات من خارجه: ' + JSON.stringify(book) + ' ' +
      'القواعد: المشهد الأول يشوّق ويطرح سؤالًا، والأخير يلخّص ويختم بسؤال للتلاميذ. ' +
      'التعليق الصوتي (narration) بعربية مبسطة تناسب الصف، من 2 إلى 3 جمل قصيرة لكل مشهد. ' +
      'الوصف المرئي (visual) بالإنجليزية فقط، جملة أو جملتان تصفان الحدث والكاميرا والمكان، ' +
      'دون وصف شكل الأستاذ فارس أو أسلوب الرسم لأنهما يُضافان لاحقًا. ' +
      'أعد JSON فقط بالشكل: {"scenes":[{"title":"عنوان قصير","narration":"...","visual":"..."}]}';
    const out = await gemini([{ text: prompt }]);
    const scenes = (out.scenes || []).slice(0, 6).map(s => ({
      title: String(s.title || ''), narration: String(s.narration || ''), visual: String(s.visual || ''),
    }));
    if (scenes.length < 3) return res.status(502).json({ error: 'gemini' });
    await db.saveScript(id, scenes);
    res.json(scenes);
  } catch (e) { fail500(res, e); }
});

app.post('/api/projects/:id/script/save', async (req, res) => {
  try {
    const scenes = req.body && req.body.scenes;
    if (!Array.isArray(scenes) || !scenes.length || scenes.length > 20) return res.status(400).json({ error: 'invalid' });
    const clean = scenes.map(s => ({
      title: String(s.title || '').slice(0, 200),
      narration: String(s.narration || '').slice(0, 2000),
      visual: String(s.visual || '').slice(0, 2000),
    }));
    await db.saveScript(+req.params.id, clean);
    res.json({ ok: true });
  } catch (e) { fail500(res, e); }
});

db.migrate().then(() => console.log('migrations ok')).catch(e => console.error('migrate:', e.message));

app.listen(PORT, () => console.log('Faris Studio on ' + PORT));
