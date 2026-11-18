import "dotenv/config";
import http from "node:http";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 10000);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      status: "ok",
      service: "FARIS AI STUDIO",
      workerConfigured: Boolean(process.env.DATABASE_URL && process.env.GEMINI_API_KEY)
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`FARIS AI STUDIO server listening on port ${port}`);

  if (!process.env.DATABASE_URL || !process.env.GEMINI_API_KEY) {
    console.warn("Worker not started: DATABASE_URL and GEMINI_API_KEY must be configured in Render Environment.");
    return;
  }

  const worker = spawn(process.execPath, ["worker.js"], {
    env: process.env,
    stdio: "inherit"
  });

  worker.on("error", error => {
    console.error("Could not start worker:", error);
  });

  worker.on("exit", (code, signal) => {
    console.error(`Worker stopped (code=${code}, signal=${signal}). The web server remains available.`);
  });
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
