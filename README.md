# FARIS AI STUDIO

Arabic-first educational content production backend.

## Render services
Create two services from this repository:
1. **Web Service**: Build `npm install`, Start `npm start`.
2. **Background Worker**: Start `npm run worker`. This process must be separate from the web service so video jobs are not tied to HTTP request lifetime.

Use Node.js 20+.

## Environment variables
Set the same required variables on both Render services:
- `DATABASE_URL`: Neon pooled PostgreSQL connection string.
- `FARIS_API_TOKEN`: long random secret used as a Bearer token for the current protected API.
- `GEMINI_API_KEY`: required on the worker for script generation.

Optional worker variables:
- `GEMINI_MODEL`: defaults to `gemini-2.5-flash`.
- `POLL_INTERVAL_MS`: defaults to 5000.
- `MAX_ATTEMPTS`: defaults to 3.
- `VIDEO_PROVIDER_URL` and `VIDEO_PROVIDER_API_KEY`: only after selecting and implementing a compatible real provider.

Never commit secrets or put them in browser code.

## Database
Run `migrations/001_init.sql` in Neon SQL Editor. No curriculum records are seeded; only explicitly approved source lessons can be processed.

## API
All API routes except `GET /health` require:
`Authorization: Bearer <FARIS_API_TOKEN>`

- `GET /health`: checks HTTP and PostgreSQL availability.
- `POST /api/jobs`: body `{"lesson_id":"UUID"}`, plus an `Idempotency-Key` header (8–128 chars).
- `GET /api/jobs/:id`: reads the job state.

The current token is a single-service credential, not a finished per-user authentication system. Do not expose it in a public web page or mobile app. A production client must use a proper user-authentication layer and server-side authorization.

## Current capability limits
- The worker can prepare scripts with Gemini.
- Real video rendering requires a compatible provider integration.
- Durable object storage and device push notifications are not implemented yet.
- Database notifications are not equivalent to push notifications.
- A successful health check proves database connectivity only, not Gemini or video-provider readiness.
