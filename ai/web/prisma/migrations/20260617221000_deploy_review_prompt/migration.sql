-- Add configurable deploy-review prompt defaults.
ALTER TABLE "Project" ADD COLUMN "deploy_review_prompt" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "deploy_review_prompt" TEXT;
