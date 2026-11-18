import "dotenv/config";
import http from "node:http";
import { query, pool } from "./db.js";

const port = Number(process.env.PORT || 10000);
const apiToken = process.env.FARIS_API_TOKEN;

function send(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  if (!apiToken) return false;
  const header = req.headers.authorization || "";
  return header === `Bearer ${apiToken}`;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 32_000) throw new Error("REQUEST_TOO_LARGE");
  }
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      try {
        await query("SELECT 1");
        return send(res, 200, { status: "ok", service: "FARIS AI STUDIO", database: "connected" });
      } catch {
        return send(res, 503, { status: "degraded", service: "FARIS AI STUDIO", database: "unavailable" });
      }
    }

    if (!authorized(req)) {
      return send(res, apiToken ? 401 : 503, {
        error: apiToken ? "UNAUTHORIZED" : "SERVER_CONFIGURATION_REQUIRED",
        message: apiToken ? "يلزم رمز وصول صحيح." : "يجب ضبط FARIS_API_TOKEN في إعدادات الخادم."
      });
    }

    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const body = await readJson(req);
      const lessonId = String(body.lesson_id || "");
      const idempotencyKey = String(req.headers["idempotency-key"] || body.idempotency_key || "");

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lessonId)) {
        return send(res, 400, { error: "INVALID_LESSON_ID", message: "معرّف الدرس غير صالح." });
      }
      if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
        return send(res, 400, { error: "IDEMPOTENCY_KEY_REQUIRED", message: "أرسل مفتاح طلب فريداً بطول 8 إلى 128 حرفاً." });
      }

      const lesson = await query(
        "SELECT id FROM lessons WHERE id=$1 AND approved=TRUE",
        [lessonId]
      );
      if (!lesson.rowCount) {
        return send(res, 404, { error: "APPROVED_LESSON_NOT_FOUND", message: "الدرس غير موجود أو لم تتم الموافقة عليه." });
      }

      const inserted = await query(
        `INSERT INTO production_jobs (lesson_id, idempotency_key)
         VALUES ($1, $2)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, status, stage, progress, created_at`,
        [lessonId, idempotencyKey]
      );

      if (inserted.rowCount) return send(res, 201, { job: inserted.rows[0], reused: false });

      const existing = await query(
        "SELECT id, status, stage, progress, created_at FROM production_jobs WHERE idempotency_key=$1",
        [idempotencyKey]
      );
      return send(res, 200, { job: existing.rows[0], reused: true });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && jobMatch) {
      const result = await query(
        `SELECT id, lesson_id, status, stage, progress, script_json,
                video_url, error_message, created_at, updated_at, completed_at
         FROM production_jobs WHERE id=$1`,
        [jobMatch[1]]
      );
      if (!result.rowCount) return send(res, 404, { error: "JOB_NOT_FOUND" });
      return send(res, 200, { job: result.rows[0] });
    }

    return send(res, 404, { error: "NOT_FOUND" });
  } catch (error) {
    if (error.message === "REQUEST_TOO_LARGE") {
      return send(res, 413, { error: "REQUEST_TOO_LARGE" });
    }
    if (error instanceof SyntaxError) {
      return send(res, 400, { error: "INVALID_JSON" });
    }
    console.error("Request failed:", error.message);
    return send(res, 500, { error: "INTERNAL_ERROR" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`FARIS AI STUDIO API listening on port ${port}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
