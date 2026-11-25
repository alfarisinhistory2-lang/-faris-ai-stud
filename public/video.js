/* تجميع الفيديو داخل المتصفح: صور المشاهد + أصواتها → فيديو واحد */
(() => {
  const box = document.getElementById('pjActions');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', `
    <div style="margin-top:18px">
      <label style="display:flex;align-items:center;gap:10px;margin:0 0 10px">
        <input type="checkbox" id="vidCaps" checked style="width:20px;height:20px;padding:0;flex:none">
        <span>إظهار نص التعليق على الفيديو</span>
      </label>
      <button class="btn" id="buildVideo">🎬 تجميع الفيديو</button>
      <p class="muted" style="margin-top:8px">يستغرق بقدر مدة الفيديو. أبقِ الشاشة مضاءة والصفحة مفتوحة حتى ينتهي.</p>
      <div id="vidResult"></div>
    </div>`);

  const W = 1280, H = 720;
  const FONT = '"Tajawal", Tahoma, sans-serif';
  const loadImage = url => new Promise((ok, no) => {
    const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = url;
  });

  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function draw(ctx, it, p, caps) {
    ctx.fillStyle = '#12121a'; ctx.fillRect(0, 0, W, H);
    ctx.direction = 'rtl'; ctx.textAlign = 'center';
    if (it.img) {
      const k = Math.max(W / it.img.width, H / it.img.height) * (1 + 0.06 * p);
      const w = it.img.width * k, h = it.img.height * k;
      ctx.drawImage(it.img, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#2b2b38'); g.addColorStop(1, '#12121a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#45F3FF'; ctx.font = '700 60px ' + FONT;
      ctx.fillText(it.title || '', W / 2, H / 2);
    }
    if (caps && it.text) {
      ctx.font = '700 32px ' + FONT;
      const lines = wrap(ctx, it.text, W - 180).slice(0, 4);
      const lh = 46, bh = lines.length * lh + 28;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, H - bh, W, bh);
      ctx.fillStyle = '#fff';
      lines.forEach((l, i) => ctx.fillText(l, W / 2, H - bh + 14 + lh * (i + 0.75)));
    }
  }

  const animate = (dur, fn) => new Promise(resolve => {
    const t0 = performance.now();
    const frame = now => {
      const p = Math.min(1, (now - t0) / (dur * 1000));
      fn(p);
      if (p < 1) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });

  $('#buildVideo').onclick = async () => {
    const btn = $('#buildVideo'), res = $('#vidResult');
    if (!pjId || !pjScenes.length) return toast('اختر مشروعاً له سيناريو');
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mime = window.MediaRecorder && types.find(t => MediaRecorder.isTypeSupported(t));
    if (!mime) return toast('هذا المتصفح لا يدعم تسجيل الفيديو. استخدم Chrome');
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const caps = $('#vidCaps').checked;
    const AC = window.AudioContext || window.webkitAudioContext;
    let ac;
    btn.disabled = true; res.innerHTML = '';
    try {
      await loadPjMedia();
      ac = new AC(); await ac.resume();
      const dest = ac.createMediaStreamDestination();
      const items = [];
      for (let i = 0; i < pjScenes.length; i++) {
        btn.textContent = `جارٍ تحضير الملفات… ${i + 1} من ${pjScenes.length}`;
        const n = i + 1, im = latestMedia(`scene-${n}-image.`), au = latestMedia(`scene-${n}-audio.`);
        const it = { title: pjScenes[i].title, text: pjScenes[i].narration, img: null, buf: null };
        if (im) { try { it.img = await loadImage(mediaUrl(pjId, im.name)); } catch {} }
        if (au) {
          try {
            const ab = await (await fetch(mediaUrl(pjId, au.name))).arrayBuffer();
            it.buf = await ac.decodeAudioData(ab);
          } catch {}
        }
        it.dur = it.buf ? it.buf.duration + 0.5 : 4;
        items.push(it);
      }
      if (!items.some(x => x.img || x.buf)) throw new Error('empty');

      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      draw(ctx, items[0], 0, caps);
      const stream = canvas.captureStream(30);
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 800000, audioBitsPerSecond: 96000 });
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise(r => { rec.onstop = r; });
      rec.start(1000);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        btn.textContent = `جارٍ التجميع… مشهد ${i + 1} من ${items.length}`;
        if (it.buf) { const src = ac.createBufferSource(); src.buffer = it.buf; src.connect(dest); src.start(); }
        await animate(it.dur, p => draw(ctx, it, p, caps));
      }
      await sleep(300); rec.stop(); await stopped;

      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      const url = URL.createObjectURL(blob), name = `video-${Date.now()}.${ext}`;
      res.innerHTML = `<video class="media" controls playsinline src="${url}"></video>
        <p class="muted" style="margin-top:8px">الحجم: ${fmtSize(blob.size)}</p>
        <div class="row" style="margin-top:10px">
          <a class="btn small" style="text-decoration:none" href="${url}" download="${name}">⬇️ تنزيل</a>
          <button class="btn small alt" id="saveVid">حفظ في المكتبة</button>
        </div>`;
      $('#saveVid').onclick = async () => {
        if (blob.size > MAX_UP) return toast('الفيديو أكبر من 14 ميغابايت، نزّله مباشرة');
        try { toast('جارٍ الحفظ…'); await uploadMedia(pjId, name, blob.type, await fileToB64(blob)); toast('تم الحفظ في مكتبة الدرس'); }
        catch (err) { upErr(err); }
      };
      toast('اكتمل التجميع');
    } catch (e) {
      toast(e.message === 'empty' ? 'لا توجد صور ولا أصوات لهذا الدرس بعد' : 'تعذّر تجميع الفيديو');
    }
    if (ac) ac.close();
    btn.disabled = false; btn.textContent = '🎬 تجميع الفيديو';
  };
})();
