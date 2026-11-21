import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query, pool } from "./db.js";

const port = Number(process.env.PORT || 10000);
const apiToken = process.env.FARIS_API_TOKEN;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const allowedOrigin = process.env.APP_ORIGIN || "*";

function send(res,status,payload){
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
  res.end(JSON.stringify(payload));
}
function cors(req,res){
  const origin=req.headers.origin||"*";
  res.setHeader("Access-Control-Allow-Origin",allowedOrigin==="*"?origin:allowedOrigin);
  res.setHeader("Vary","Origin, Access-Control-Request-Headers");
  res.setHeader("Access-Control-Allow-Headers",req.headers["access-control-request-headers"]||"Authorization,Content-Type,Idempotency-Key");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Max-Age","86400");
}
function authorized(req){return Boolean(apiToken)&&req.headers.authorization===`Bearer ${apiToken}`;}
async function readJson(req,limit=2_000_000){
  let body="";
  for await(const chunk of req){body+=chunk;if(body.length>limit)throw new Error("REQUEST_TOO_LARGE");}
  return body?JSON.parse(body):{};
}

let projectsReady=false;
async function ensureProjects(){if(projectsReady)return;await query("CREATE TABLE IF NOT EXISTS studio_projects(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),grade TEXT,unit_name TEXT,lesson_name TEXT NOT NULL,duration TEXT,voice TEXT,script_json JSONB,created_at TIMESTAMPTZ DEFAULT NOW())");projectsReady=true;}

async function gemini(prompt,images=[]){
  if(!process.env.GEMINI_API_KEY)throw new Error("GEMINI_API_KEY غير مضبوط في إعدادات الخادم.");
  const candidates=[...new Set([process.env.GEMINI_MODEL,"gemini-3.8-flash","gemini-flash-latest","gemini-2.5-flash"].filter(Boolean))];
  const parts=[{text:prompt},...images.map(d=>({inlineData:{mimeType:"image/jpeg",data:d}}))];
  let data={},lastError="";
  for(const model of candidates){
    const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts}],generationConfig:{responseMimeType:"application/json",temperature:0.2,maxOutputTokens:16000}})
    });
    data=await response.json().catch(()=>({}));
    if(response.ok){console.log("Gemini model used:",model);break;}
    lastError="Gemini رفض الطلب ("+response.status+") للنموذج "+model+": "+(data.error?.message||"سبب غير معروف");
    console.error(lastError);
    data=null;
    if(response.status!==404)throw new Error(lastError);
  }
  if(!data)throw new Error(lastError+" — جرّب ضبط GEMINI_MODEL في Render على اسم نموذج متاح لمفتاحك.");
  const raw=data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("");
  if(!raw)throw new Error("Gemini لم يرجع نتيجة. السبب: "+(data.candidates?.[0]?.finishReason||data.promptFeedback?.blockReason||"غير معروف"));
  try{return JSON.parse(raw.replace(/^```json\s*/i,"").replace(/```\s*$/,"").trim());}
  catch{throw new Error("Gemini أرجع نتيجة غير مكتملة. قلّل عدد الصفحات أو استخدم فصلاً واحداً.");}
}

const server=http.createServer(async(req,res)=>{
  cors(req,res);
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}
  try{
    const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);
    if(req.method==="GET"&&url.pathname==="/"){
      const page=await readFile(path.join(publicDir,"index.html"));
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"});
      return res.end(page);
    }
    if(req.method==="GET"&&url.pathname==="/health"){
      try{await query("SELECT 1");return send(res,200,{status:"ok",service:"FARIS AI STUDIO",database:"connected",geminiConfigured:Boolean(process.env.GEMINI_API_KEY),imageAnalysis:true});}
      catch{return send(res,503,{status:"degraded",service:"FARIS AI STUDIO",database:"unavailable"});}
    }
    if(!authorized(req))return send(res,apiToken?401:503,{error:apiToken?"UNAUTHORIZED":"SERVER_CONFIGURATION_REQUIRED",message:apiToken?"يلزم رمز وصول صحيح.":"اضبط FARIS_API_TOKEN في إعدادات الخادم."});

    if(req.method==="POST"&&url.pathname==="/api/books/analyze"){
      const body=await readJson(req,8_000_000);
      const filename=String(body.filename||"كتاب.pdf").slice(0,180);
      const grade=String(body.grade||"").slice(0,100);
      const text=String(body.extracted_text||"").trim().slice(0,150000);
      const images=Array.isArray(body.images)?body.images.slice(0,6).filter(x=>typeof x==="string"&&x.length>100&&x.length<1_500_000):[];
      if(!images.length&&(!text||text.length<150))return send(res,400,{error:"PDF_TEXT_REQUIRED",message:"لم يتم استخراج نص كافٍ ولم تصل أي صور. جرّب نسخة PDF نصية أو صوّر صفحات الكتاب."});
      const prompt=`أنت محلل كتب مدرسية. حلّل المصدر المرفق فقط ولا تضف أي معلومة من خارجه. أعد JSON صالحاً بهذا الشكل: {"book_title":"اسم الكتاب إن وجد","units":[{"unit_name":"اسم الوحدة","lessons":[{"lesson_name":"اسم الدرس كما ورد","key_points":["نقطة مهمة مقتبسة بالمعنى من المصدر"],"source_excerpt":"مقتطف داعم من النص","learning_objectives":["هدف تعليمي"]}]}],"coverage_notes":["ملاحظات عن النص الناقص أو الصفحات غير الواضحة"]}. لا تخترع وحدات أو دروساً. إذا لم تجد بنية واضحة اجعل الوحدات فارغة واشرح السبب في coverage_notes. الصف: ${grade||"غير محدد"}. اسم الملف: ${filename}. النص: ${text||"(المصدر صور مرفقة لصفحات الكتاب، اقرأها بدقة)"}`;
      const analysis=await gemini(prompt,images);
      const saved=await query(`INSERT INTO book_analyses(filename,grade,extracted_text,analysis_json,status) VALUES($1,$2,$3,$4,'pending') RETURNING id,filename,grade,status,created_at`,[filename,grade,text,JSON.stringify(analysis)]);
      return send(res,201,{analysis_id:saved.rows[0].id,book:saved.rows[0],analysis});
    }

    const approveMatch=url.pathname.match(/^\/api\/books\/([0-9a-f-]{36})\/approve$/i);
    if(req.method==="POST"&&approveMatch){
      const body=await readJson(req,300_000);
      const selected=Array.isArray(body.lessons)?body.lessons:[];
      if(!selected.length||selected.length>100)return send(res,400,{error:"LESSONS_REQUIRED",message:"اختر درساً واحداً على الأقل لاعتماده."});
      const book=await query("SELECT * FROM book_analyses WHERE id=$1 AND status='pending'",[approveMatch[1]]);
      if(!book.rowCount)return send(res,404,{error:"ANALYSIS_NOT_FOUND",message:"التحليل غير موجود أو سبق اعتماده."});
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        const created=[];
        for(const item of selected){
          const unit=String(item.unit_name||"").trim().slice(0,250);
          const name=String(item.lesson_name||"").trim().slice(0,250);
          const source=String(item.source_text||"").trim();
          if(!name||source.length<30)throw new Error("كل درس يحتاج اسماً ومصدراً نصياً كافياً.");
          const inserted=await client.query("INSERT INTO lessons(grade,unit_name,lesson_name,source_text,approved) VALUES($1,$2,$3,$4,TRUE) RETURNING id,grade,unit_name,lesson_name",[
            String(body.grade||book.rows[0].grade||"غير محدد").slice(0,100),unit,name,source
          ]);
          created.push(inserted.rows[0]);
        }
        await client.query("UPDATE book_analyses SET status='approved',updated_at=NOW() WHERE id=$1",[approveMatch[1]]);
        await client.query("COMMIT");
        return send(res,201,{lessons:created,count:created.length});
      }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
    }

    if(req.method==="GET"&&url.pathname==="/api/lessons"){
      const result=await query("SELECT id,grade,unit_name,lesson_name FROM lessons WHERE approved=TRUE ORDER BY grade,unit_name,lesson_name LIMIT 300");
      return send(res,200,{lessons:result.rows});
    }
    if(req.method==="GET"&&url.pathname==="/api/jobs"){
      const result=await query(`SELECT j.id,j.lesson_id,l.grade,l.unit_name,l.lesson_name,j.status,j.stage,j.progress,j.video_url,j.created_at,j.updated_at FROM production_jobs j JOIN lessons l ON l.id=j.lesson_id ORDER BY j.created_at DESC LIMIT 50`);
      return send(res,200,{jobs:result.rows});
    }
    if(req.method==="POST"&&url.pathname==="/api/jobs"){
      const body=await readJson(req);
      const lessonId=String(body.lesson_id||"");
      const idempotencyKey=String(req.headers["idempotency-key"]||body.idempotency_key||"");
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lessonId))return send(res,400,{error:"INVALID_LESSON_ID",message:"معرّف الدرس غير صالح."});
      if(idempotencyKey.length<8||idempotencyKey.length>128)return send(res,400,{error:"IDEMPOTENCY_KEY_REQUIRED",message:"مفتاح الطلب الفريد مطلوب."});
      const lesson=await query("SELECT id FROM lessons WHERE id=$1 AND approved=TRUE",[lessonId]);
      if(!lesson.rowCount)return send(res,404,{error:"APPROVED_LESSON_NOT_FOUND",message:"الدرس غير موجود أو غير معتمد."});
      const config={style:String(body.style||"documentary").slice(0,50),presenter:String(body.presenter||"Faris").slice(0,80)};
      const inserted=await query(`INSERT INTO production_jobs(lesson_id,idempotency_key,production_config) VALUES($1,$2,$3) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id,status,stage,progress,created_at`,[lessonId,idempotencyKey,JSON.stringify(config)]);
      if(inserted.rowCount)return send(res,201,{job:inserted.rows[0],reused:false});
      const existing=await query("SELECT id,status,stage,progress,created_at FROM production_jobs WHERE idempotency_key=$1",[idempotencyKey]);
      return send(res,200,{job:existing.rows[0],reused:true});
    }
    const jobMatch=url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if(req.method==="GET"&&jobMatch){
      const result=await query("SELECT id,lesson_id,status,stage,progress,script_json,video_url,error_message,created_at,updated_at,completed_at FROM production_jobs WHERE id=$1",[jobMatch[1]]);
      if(!result.rowCount)return send(res,404,{error:"JOB_NOT_FOUND"});
      return send(res,200,{job:result.rows[0]});
    }
    if(req.method==="GET"&&url.pathname==="/api/projects"){
      await ensureProjects();
      const r=await query("SELECT id,grade,unit_name,lesson_name,duration,voice,script_json,created_at FROM studio_projects ORDER BY created_at DESC LIMIT 100");
      return send(res,200,{projects:r.rows});
    }
    const projMatch=url.pathname.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
    if(req.method==="DELETE"&&projMatch){
      await ensureProjects();
      await query("DELETE FROM studio_projects WHERE id=$1",[projMatch[1]]);
      return send(res,200,{deleted:true});
    }
    if(req.method==="POST"&&url.pathname==="/api/analyze"){
      await ensureProjects();
      const b=await readJson(req,8_000_000);
      const lesson=String(b.lesson||"").trim().slice(0,250),unit=String(b.unit||"").trim().slice(0,250),grade=String(b.grade||"").slice(0,100);
      const text=String(b.extracted_text||"").trim().slice(0,120000);
      const dur={short:"دقيقة واحدة (نحو 150 كلمة تعليق)",medium:"3 دقائق (نحو 450 كلمة)",long:"5 دقائق (نحو 750 كلمة)"}[b.duration]||"دقيقة واحدة";
      const voice=String(b.voice||"الأستاذ فارس").slice(0,80);
      if(!lesson)return send(res,400,{error:"LESSON_REQUIRED",message:"اكتب اسم الدرس."});
      if(text.length<150)return send(res,400,{error:"TEXT_REQUIRED",message:"لم يصل نص كافٍ من الكتاب. اختر PDF نصياً."});
      const mins={short:1,medium:3,long:5}[b.duration]||1,wpm={slow:110,normal:150,fast:190}[b.speed]||150,words=mins*wpm;
      const styleMap={cartoon:"كرتوني تعليمي بشخصيات وحوار",documentary:"وثائقي سينمائي بسرد ومشاهد واقعية",story:"قصة تعليمية بسرد قصصي",investigation:"تحقيق وتشويق بأدلة واستنتاج",visual:"شرح بصري بخرائط ورسوم توضيحية",classroom:"حصة صفية بشرح مباشر"};
      const langMap={fusha:"العربية الفصحى المبسطة",sudani:"اللهجة السودانية البيضاء المفهومة",english:"English"};
      const musicMap={none:"بدون موسيقى",calm:"موسيقى هادئة",epic:"موسيقى ملحمية تاريخية",playful:"موسيقى مرحة للأطفال"};
      const settings={style:styleMap[b.style]?b.style:"cartoon",aspect:b.aspect==="16:9"?"16:9":"9:16",language:langMap[b.language]?b.language:"fusha",speed:b.speed||"normal",music:musicMap[b.music]?b.music:"calm",characters:String(b.characters||"").slice(0,400)};
      const prompt=`أنت كاتب سيناريو فيديو تعليمي للتاريخ. اعتمد على نص الكتاب فقط ولا تضف معلومات من خارجه. الدرس: "${lesson}" من الوحدة "${unit}". الصف: ${grade||"غير محدد"}. الأسلوب: ${styleMap[settings.style]}. نسبة الشاشة: ${settings.aspect} (اجعل وصف المشاهد مناسباً لها). مدة الفيديو: ${mins} دقيقة، وعدد كلمات التعليق الكلي نحو ${words} كلمة. لغة التعليق: ${langMap[settings.language]}. الموسيقى: ${musicMap[settings.music]}. المعلّق: ${voice}. الشخصيات: ${settings.characters||"الأستاذ فارس مقدّماً"}. أعد JSON صالحاً بالشكل: {"title":"","summary":"","scenes":[{"scene":1,"visual":"وصف المشهد","narration":"نص التعليق","music":"ملاحظة الموسيقى والمؤثرات","seconds":10}],"quiz":[{"q":"","a":""}],"coverage_notes":["ملاحظة إن كان الدرس غير واضح في النص"]}. النص: ${text}`;
      const script=await gemini(prompt);script.settings=settings;
      const r=await query("INSERT INTO studio_projects(grade,unit_name,lesson_name,duration,voice,script_json) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,grade,unit_name,lesson_name,duration,voice,script_json,created_at",[grade,unit,lesson,String(b.duration||"short"),voice,JSON.stringify(script)]);
      return send(res,201,{project:r.rows[0]});
    }
    return send(res,404,{error:"NOT_FOUND"});
  }catch(error){
    if(error.message==="REQUEST_TOO_LARGE")return send(res,413,{error:"REQUEST_TOO_LARGE",message:"حجم الطلب كبير. قلّل عدد الصور أو التقطها بدقة أقل."});
    if(error instanceof SyntaxError)return send(res,400,{error:"INVALID_JSON"});
    console.error("Request failed:",error.message);
    return send(res,500,{error:"INTERNAL_ERROR",message:error.message});
  }
});
server.listen(port,"0.0.0.0",()=>console.log(`FARIS AI STUDIO listening on port ${port}`));
async function shutdown(){server.close(async()=>{await pool.end();process.exit(0);});}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
