-- FARIS AI STUDIO: book analysis and production configuration
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS lessons (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 grade TEXT NOT NULL, unit_name TEXT, lesson_name TEXT NOT NULL,
 source_text TEXT NOT NULL, approved BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS book_analyses (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 filename TEXT NOT NULL, grade TEXT, extracted_text TEXT NOT NULL,
 analysis_json JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
   CHECK(status IN ('pending','approved','rejected')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS production_jobs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'queued'
   CHECK(status IN ('queued','processing','waiting_provider','completed','failed','cancelled')),
 stage TEXT NOT NULL DEFAULT 'في قائمة الانتظار',
 progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 worker_id TEXT, locked_at TIMESTAMPTZ, script_json JSONB, video_url TEXT,
 error_message TEXT, idempotency_key TEXT UNIQUE,
 production_config JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);
ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS production_config JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_production_jobs_queue ON production_jobs(created_at) WHERE status='queued';
CREATE INDEX IF NOT EXISTS idx_production_jobs_stale ON production_jobs(locked_at) WHERE status IN ('processing','waiting_provider');
CREATE INDEX IF NOT EXISTS idx_production_jobs_lesson ON production_jobs(lesson_id,created_at DESC);
CREATE TABLE IF NOT EXISTS app_notifications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id UUID REFERENCES production_jobs(id) ON DELETE CASCADE,
 title TEXT NOT NULL, body TEXT NOT NULL, read_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_notifications_unread ON app_notifications(created_at DESC) WHERE read_at IS NULL;
