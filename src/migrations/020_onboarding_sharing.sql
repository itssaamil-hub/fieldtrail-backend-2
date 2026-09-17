ALTER TABLE onboarding_template ADD COLUMN IF NOT EXISTS sharing JSONB NOT NULL DEFAULT '{
 "title":"Your restaurant is now live on Swirl!",
 "intro":"Hello {owner},\n\nYour setup is complete, and {restaurant} is now live on Swirl.",
 "closing":"Thank you for choosing Swirl. Please contact our team if you need assistance.\n\nTeam Swirl"
}'::jsonb;
