-- Admin-managed Gemini writing instructions and de-identified, approved examples.
-- These are backend-only tables; never expose training data in the public Data API.
CREATE TABLE IF NOT EXISTS ai_writer_training_config (
  id integer PRIMARY KEY CHECK (id = 1),
  company_knowledge text NOT NULL DEFAULT '',
  writing_instructions text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_training_knowledge_length CHECK (length(company_knowledge) <= 5000),
  CONSTRAINT ai_training_instructions_length CHECK (length(writing_instructions) <= 3000)
);

INSERT INTO ai_writer_training_config(id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_writer_training_examples (
  id uuid PRIMARY KEY,
  message text NOT NULL,
  language text NOT NULL CHECK (language IN ('english','hinglish','hindi')),
  message_type text NOT NULL CHECK (message_type IN ('first','after','followup')),
  goal text NOT NULL CHECK (goal IN ('demo','trial','pricing','decision','stay')),
  tone text NOT NULL CHECK (tone IN ('respectful','friendly','casual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CONSTRAINT ai_training_example_length CHECK (length(message) BETWEEN 25 AND 1200)
);
CREATE INDEX IF NOT EXISTS idx_ai_writer_training_examples_review
 ON ai_writer_training_examples(status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_ai_writer_training_examples_approved
 ON ai_writer_training_examples(language, message_type, created_at DESC)
 WHERE status = 'approved';

ALTER TABLE ai_writer_training_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_writer_training_examples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_writer_training_config, ai_writer_training_examples FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
   REVOKE ALL ON ai_writer_training_config, ai_writer_training_examples FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
   REVOKE ALL ON ai_writer_training_config, ai_writer_training_examples FROM authenticated;
 END IF;
END $$;
