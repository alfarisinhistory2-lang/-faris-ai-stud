# FARIS AI STUDIO

Arabic-first educational content production platform.

## Current repository status
This repository contains the Node.js service entry point, PostgreSQL connection module, and background production worker. The worker can prepare a lesson script with Gemini. Real video rendering, durable media storage, user authentication, and device push notifications require their respective providers and configuration.

## Render
- Runtime: Node.js 20+
- Build command: `npm install`
- Start command: `npm start`
- Health endpoint: `/health`

## Required environment variables
Set these in Render Dashboard → service → Environment. Never commit real values.

- `DATABASE_URL`: Neon pooled PostgreSQL connection string.
- `GEMINI_API_KEY`: Gemini API key.

Optional:
- `GEMINI_MODEL`: defaults to `gemini-2.5-flash`.
- `POLL_INTERVAL_MS`: worker polling interval; defaults to 5000.
- `MAX_ATTEMPTS`: worker retry limit; defaults to 3.
- `VIDEO_PROVIDER_URL` and `VIDEO_PROVIDER_API_KEY`: required only after choosing and implementing a compatible video provider.

## Database setup
Run `migrations/001_init.sql` in the Neon SQL Editor. It creates the minimum tables currently referenced by `worker.js`. It intentionally inserts no curriculum content.

## Important limitations
- `/health` confirms the HTTP process is responding; it does not prove database or Gemini connectivity.
- A row in `app_notifications` is an in-app database notification, not a device push notification.
- Do not mark video jobs completed until a real provider returns a valid video URL and the media is stored durably.
- The current worker is an initial implementation. Test retries, stale-job recovery, and provider idempotency before production use.
