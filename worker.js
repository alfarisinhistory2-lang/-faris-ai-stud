import "dotenv/config";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { pool, query } from "./db.js";

const workerId = `${os.hostname()}-${process.pid}`;
const pollMs = Number(process.env.POLL_INTERVAL_MS || 5000);
const maxAttempts = Number(process.env.MAX_ATTEMPTS || 3);

async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT id,lesson_id,attempts,production_config FROM production_jobs
       WHERE status='queued'
       ORDER BY created_at
       LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (!found.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const job = found.rows[0];
    await client.query(
      `UPDATE production_jobs
       SET status='processing',stage='تحضير محتوى الدرس',progress=5,
           attempts=attempts+1,worker_id=$2,locked_at=NOW(),updated_at=NOW()
       WHERE id=$1`,
      [job.id, workerId]
    );
    await client.query("COMMIT");
    return { ...job, attempts: job.attempts + 1 };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function makeScript(lesson, productionConfig = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY غير مضبوط؛ لا يمكن إعداد السيناريو تلقائياً.");
  }
  const candidates = [
    ...new Set(
      [process.env.GEMINI_MODEL, "gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"].filter(Boolean)
    )
  ];
  const prompt = `أنت مساعد إعداد حصص تعليمية. استخدم المصدر فقط ولا تضف حقائق غير موجودة فيه.
أعد JSON صالحاً فقط بالشكل:
{"learningObjectives":[],"script":"...","scenes":[{"number":1,"durationSeconds":8,"visual":"...","voiceover":"..."}]}
أسلوب الفيديو المطلوب: ${productionConfig.style || "وثائقي سينمائي"}.
مقدم الحصة: ${productionConfig.presenter || "الأستاذ فارس"}.
بيانات الدرس:
الصف: ${lesson.grade}
الوحدة: ${lesson.unit_name || ""}
الدرس: ${lesson.lesson_name}
المصدر:
${lesson.source_text}`;

  let data = null;
  let lastError = "";
  for (const model of candidates) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        })
      }
    );
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      data = body;
      console.log("Gemini model used:", model);
      break;
    }
    lastError = `Gemini API error ${response.status} (${model}): ${body.error?.message || "unknown"}`;
    console.error(lastError);
    if (response.status !== 404) throw new Error(lastError);
  }
  if (!data) throw new Error(lastError || "تعذر الوصول إلى أي نموذج Gemini");

  const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("");
  if (!raw) throw new Error("لم يرجع Gemini سيناريو");
  return JSON.parse(raw);
}

async function processJob(job) {
  const lessonResult = await query("SELECT * FROM lessons WHERE id=$1", [job.lesson_id]);
  if (!lessonResult.rowCount || !lessonResult.rows[0].approved) {
    throw new Error("الدرس غير موجود أو لم يعد معتمداً");
  }
  const lesson = lessonResult.rows[0];
  const script = await makeScript(lesson, job.production_config || {});
  await query(
    `UPDATE production_jobs SET script_json=$2,progress=25,stage='السيناريو جاهز؛ بانتظار خدمة توليد الفيديو',
     status='waiting_provider',updated_at=NOW() WHERE id=$1`,
    [job.id, JSON.stringify(script)]
  );

  // Keep the prepared script safely available until a real video provider is configured.
  if (!process.env.VIDEO_PROVIDER_URL || !process.env.VIDEO_PROVIDER_API_KEY) {
    await query(
      `UPDATE production_jobs SET status='waiting_provider',progress=25,
       stage='السيناريو جاهز؛ بانتظار ربط مزود الفيديو',
       worker_id=NULL,locked_at=NULL,updated_at=NOW() WHERE id=$1`,
      [job.id]
    );
    console.log(`Job ${job.id}: script prepared; waiting for video provider configuration.`);
    return;
  }

  await query(
    `UPDATE production_jobs SET status='processing',progress=35,
     stage='إرسال السيناريو إلى مزود الفيديو',locked_at=NOW(),updated_at=NOW()
     WHERE id=$1`,
    [job.id]
  );

  const providerResponse = await fetch(process.env.VIDEO_PROVIDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.VIDEO_PROVIDER_API_KEY}`
    },
    body: JSON.stringify({ lesson, script, jobId: job.id })
  });
  if (!providerResponse.ok) throw new Error(`Video provider error: ${providerResponse.status}`);
  const providerData = await providerResponse.json();
  if (!providerData.video_url) throw new Error("خدمة الفيديو لم ترجع video_url صالحاً");

  await query(
    `UPDATE production_jobs SET status='completed',progress=100,stage='اكتمل الفيديو',
     video_url=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1`,
    [job.id, providerData.video_url]
  );
  await query(
    `INSERT INTO app_notifications(job_id,title,body)
     VALUES($1,$2,$3)`,
    [job.id, "اكتمل الفيديو", `اكتمل فيديو الدرس: ${lesson.lesson_name}`]
  );
}

async function loop() {
  console.log(`FARIS worker started: ${workerId}`);
  while (true) {
    try {
      const job = await claimJob();
      if (!job) {
        // Recover stale processing jobs after a worker crash.
        await query(
          `UPDATE production_jobs SET status='queued',worker_id=NULL,locked_at=NULL,
           stage='استئناف بعد انقطاع العامل',updated_at=NOW()
           WHERE status='processing'
             AND locked_at < NOW() - INTERVAL '10 minutes'`
        );
        await delay(pollMs);
        continue;
      }
      try {
        await processJob(job);
      } catch (error) {
        const terminal = job.attempts >= maxAttempts;
        await query(
          `UPDATE production_jobs SET status=$2,stage=$3,error_message=$4,
           worker_id=NULL,locked_at=NULL,updated_at=NOW()
           WHERE id=$1`,
          [job.id, terminal ? "failed" : "queued",
           terminal ? "توقفت بعد تجاوز محاولات الإعادة" : "إعادة المحاولة تلقائياً",
           String(error.message || error).slice(0, 1000)]
        );
        console.error(`Job ${job.id}:`, error);
      }
    } catch (error) {
      console.error("Worker loop error:", error);
      await delay(pollMs);
    }
  }
}

loop().catch(async e => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
