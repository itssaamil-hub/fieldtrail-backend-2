-- Extend AI Writer example types without altering existing records or review status.
-- Migration 122 created this generated name for the message_type CHECK constraint.
ALTER TABLE ai_writer_training_examples
  DROP CONSTRAINT IF EXISTS ai_writer_training_examples_message_type_check;
ALTER TABLE ai_writer_training_examples
  ADD CONSTRAINT ai_writer_training_examples_message_type_check
  CHECK (message_type IN ('first','after','followup','custom'));
