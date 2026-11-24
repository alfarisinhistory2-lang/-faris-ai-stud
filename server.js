const express = require('express');
const path = require('path');
const db = require('./db');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

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
const sleep = ms => new Promise(s => setTimeout(s, ms));

/* ===== التخزين (Neon Object Storage عبر S3) ===== */
const S3_READY = () => !!(process.env.S3_BUCKET && process.env.S3_ENDPOINT &&
  process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
let s3client = null;
const s3 = () => s3client || (s3client = new S3Client({
  region: process.env.S3_REGION || 'us-east-2',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
}));

async function storageStatus() {
  if (!S3_READY()) return { ok: false, msg: 'متغيرات S3 غير مضبوطة في Render' };
  try {
    await s3().send(new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, MaxKeys: 1 }));
    return { ok: true, msg: 'متصل بتخزين Neon' };
  } catch (e) {
    console.error('s3:', e.name, e.message);
    return { ok: false, msg: 'تعذّر الاتصال بالتخزين' };
  }
}

/* ===== Gemini: النصوص ===== */
const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.8-flash-lite'];

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

/* ===== Gemini: توليد الصور والصوت ===== */
const GEN_BASE = 'https://generativelanguage.googleapis.com/v1beta';
let modelCache = null, modelCacheAt = 0;

async function listGenModels() {
  if (modelCache && Date.now() - modelCacheAt < 3600000) return modelCache;
  const r = await fetch(`${GEN_BASE}/models?pageSize=200&key=${process.env.GEMINI_API_KEY}`);
  const j = await r.json();
  if (!r.ok) {
    console.error('models:', JSON.stringify(j).slice(0, 200));
    const e = new Error('models list failed'); e.code = 'gemini'; throw e;
  }
  modelCache = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''));
  modelCacheAt = Date.now();
  return modelCache;
}
const rank = n => (/flash/.test(n) ? 0 : 2) + (/preview|exp/.test(n) ? 1 : 0);

async function genMedia(kind, parts, genConfig) {
  if (!process.env.GEMINI_API_KEY) { const e = new Error('no key'); e.code = 'gemini'; throw e; }
  const all = await listGenModels();
  const re = kind === 'image' ? /image/ : /tts/;
  const models = all.filter(n => re.test(n)).sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  if (!models.length) { const e = new Error('no ' + kind + ' model'); e.code = 'nomodel'; throw e; }
  let quota = false;
  for (const model of models) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(`${GEN_BASE}/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: genConfig }),
        });
        const j = await r.json();
        if (r.ok) {
          const ps = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
          const p = ps.find(x => x.inlineData || x.inline_data);
          if (p) {
            const d = p.inlineData || p.inline_data;
            return { data: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type || '' };
          }
          console.error('gemini[' + model + '] no media:', JSON.stringify(j).slice(0, 200));
          break;
        }
        console.error('gemini[' + model + ']:', JSON.stringify(j).slice(0, 200));
        if (r.status === 429) { quota = true; break; }
        if (r.status === 503) { await sleep(3000); continue; }
        break;
      } catch (e) {
        console.error('gemini[' + model + '] error:', e.message);
        await sleep(2000);
      }
    }
  }
  const e = new Error(quota ? 'quota' : 'gemini failed'); e.code = quota ? 'quota' : 'gemini'; throw e;
}

function genFail(res, e) {
  console.error('gen:', e.message);
  if (e.code === 'quota') return res.status(429).json({ error: 'quota' });
  if (e.code === 'nomodel') return res.status(501).json({ error: 'nomodel' });
  if (e.code === 'gemini') return res.status(502).json({ error: 'gemini' });
  res.status(500).json({ error: 'server' });
}

function pcmToWav(pcm, rate) {
  const ch = 1, bits = 16, h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * bits / 8, 28); h.writeUInt16LE(ch * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/* ===== الحالة والإعدادات ===== */
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
    storage: await storageStatus(),
  });
});

app.get('/api/settings/models', async (req, res) => {
  try {
    const all = await listGenModels();
    res.json({
      image: all.filter(n => /image/.test(n)),
      tts: all.filter(n => /tts/.test(n)),
      text: all.filter(n => /flash/.test(n) && !/image|tts/.test(n)).slice(0, 10),
    });
  } catch (e) { fail500(res, e); }
});

app.post('/api/settings/migrate', async (req, res) => {
  try { await db.migrate(); res.json({ ok: true }); } catch (e) { fail500(res, e); }
});

/* ===== المشاريع ===== */
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

/* ===== تحليل الكتاب ===== */
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

/* ===== السيناريو ===== */
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

/* ===== ملفات الدرس (صور، صوت، فيديو): لكل درس مجلد مستقل ===== */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

app.post('/api/projects/:id/media', async (req, res) => {
  try {
    if (!S3_READY()) return res.status(503).json({ error: 'storage' });
    const id = +req.params.id;
    const { name, mime, data } = req.body || {};
    if (!id || !SAFE_NAME.test(name || '') || typeof data !== 'string' || !data) return res.status(400).json({ error: 'invalid' });
    const body = Buffer.from(data, 'base64');
    if (!body.length || body.length > 18 * 1024 * 1024) return res.status(400).json({ error: 'size' });
    await s3().send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: `lesson-${id}/${name}`,
      Body: body,
      ContentType: typeof mime === 'string' ? mime.slice(0, 100) : 'application/octet-stream',
    }));
    res.json({ ok: true, name, size: body.length });
  } catch (e) { fail500(res, e); }
});

app.get('/api/projects/:id/media', async (req, res) => {
  try {
    if (!S3_READY()) return res.status(503).json({ error: 'storage' });
    const id = +req.params.id;
    const out = await s3().send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET, Prefix: `lesson-${id}/`, MaxKeys: 200,
    }));
    res.json((out.Contents || []).map(o => ({ name: o.Key.split('/').pop(), size: o.Size, modified: o.LastModified })));
  } catch (e) { fail500(res, e); }
});

app.get('/api/projects/:id/media/:name', async (req, res) => {
  try {
    if (!S3_READY()) return res.status(503).json({ error: 'storage' });
    const id = +req.params.id;
    if (!SAFE_NAME.test(req.params.name)) return res.status(400).json({ error: 'invalid' });
    const out = await s3().send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: `lesson-${id}/${req.params.name}`,
    }));
    res.set('Content-Type', out.ContentType || 'application/octet-stream');
    if (out.ContentLength) res.set('Content-Length', String(out.ContentLength));
    out.Body.pipe(res);
  } catch (e) {
    if (e.name === 'NoSuchKey') return res.status(404).json({ error: 'not found' });
    fail500(res, e);
  }
});

/* ===== توليد صورة مشهد ===== */
app.post('/api/projects/:id/scenes/:n/image', async (req, res) => {
  try {
    if (!S3_READY()) return res.status(503).json({ error: 'storage' });
    const id = +req.params.id, n = +req.params.n;
    const prompt = req.body && req.body.prompt;
    if (!id || !(n >= 1 && n <= 20) || typeof prompt !== 'string' || prompt.length < 10 || prompt.length > 6000)
      return res.status(400).json({ error: 'invalid' });
    const out = await genMedia('image', [{ text: prompt }], { responseModalities: ['TEXT', 'IMAGE'] });
    const ext = /png/i.test(out.mime) ? 'png' : /webp/i.test(out.mime) ? 'webp' : 'jpg';
    const name = `scene-${n}-image.${ext}`;
    await s3().send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: `lesson-${id}/${name}`, Body: out.data, ContentType: out.mime || 'image/png',
    }));
    res.json({ ok: true, name });
  } catch (e) { genFail(res, e); }
});

/* ===== توليد صوت مشهد (من التعليق المحفوظ في السيناريو) ===== */
app.post('/api/projects/:id/scenes/:n/audio', async (req, res) => {
  try {
    if (!S3_READY()) return res.status(503).json({ error: 'storage' });
    const id = +req.params.id, n = +req.params.n;
    if (!id || !(n >= 1 && n <= 20)) return res.status(400).json({ error: 'invalid' });
    const script = await db.getScript(id);
    const scene = script && script[n - 1];
    if (!scene || !scene.narration) return res.status(400).json({ error: 'no script' });
    const text = 'Read the following Arabic text aloud in a warm, clear, friendly adult male teacher voice at a calm pace suitable for school children:\n' + scene.narration;
    const out = await genMedia('tts', [{ text }], {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.TTS_VOICE || 'Charon' } } },
    });
    let buf = out.data, mime = 'audio/wav';
    if (/^RIFF/.test(buf.slice(0, 4).toString('latin1'))) {
      mime = 'audio/wav';
    } else if (/L16|pcm/i.test(out.mime)) {
      const m = /rate=(\d+)/.exec(out.mime);
      buf = pcmToWav(buf, m ? +m[1] : 24000);
    } else if (/mpeg|mp3/i.test(out.mime)) {
      mime = 'audio/mpeg';
    }
    const name = `scene-${n}-audio.${mime === 'audio/mpeg' ? 'mp3' : 'wav'}`;
    await s3().send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: `lesson-${id}/${name}`, Body: buf, ContentType: mime,
    }));
    res.json({ ok: true, name });
  } catch (e) { genFail(res, e); }
});

db.migrate().then(() => console.log('migrations ok')).catch(e => console.error('migrate:', e.message));

app.listen(PORT, () => console.log('Faris Studio on ' + PORT));
