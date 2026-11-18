# FARIS AI STUDIO

Arabic-first educational content production platform.

## Services
Deploy two Render services from this repository:

1. **Web Service**
   - Build: `npm install`
   - Start: `npm start`
   - Health check: `/health`
   - Dashboard: `/`

2. **Background Worker**
   - Start: `npm run worker`
   - No public web port is needed.

Both services require the same `DATABASE_URL`. The worker also requires `GEMINI_API_KEY`.

## Environment variables
Set secrets in Render → service → Environment. Never commit real values.

Required:
- `DATABASE_URL`: Neon PostgreSQL connection string.
- `FARIS_API_TOKEN`: long random secret protecting the current API.
- `GEMINI_API_KEY`: Gemini API key (worker).

Optional:
- `GEMINI_MODEL`: defaults to `gemini-2.5-flash`.
- `POLL_INTERVAL_MS`: defaults to 5000.
- `MAX_ATTEMPTS`: defaults to 3.
- `VIDEO_PROVIDER_URL` and `VIDEO_PROVIDER_API_KEY`: only after implementing a compatible real provider.

The dashboard asks for `FARIS_API_TOKEN) and keeps it in page memory only. Do not publish this token or embed it in a public mobile app. This is a temporary single-token admin gate, not per-user authentication.

## Database setup
Run `migrations/001_init.sql` in the Neon SQL Editor. No curriculum records are inserted. Only lessons that an authorized administrator has explicitly marked approved can be queued.

## Current API
Except `GET /` and `GET /health`, API routes require:
`Authorization: Bearer <FARIS_API_TOKEN>`

- `GET /api/lessons`: list approved lessons.
- `GET /api/jobs`: latest 50 jobs.
- `POST /api/jobs`: create a job; JSON body `{"lesson_id":"UUID"}` and an `Idempotency-Key` header are required.
- `GET /api/jobs/:id`: inspect a job.

## Honest capability status
- The dashboard and job-management API are implemented in the repository.
- The worker can prepare a lesson script with Gemini.
- A real video provider and durable object storage are not yet configured.
- Database notifications are not device push notifications.
- The current single-token access gate is not a finished account/roles system.
- A successful health check verifies PostgreSQL connectivity, not Gemini or video-provider readiness.
- Run the SQL migration in Neon before expecting the API to return lessons and jobs.
