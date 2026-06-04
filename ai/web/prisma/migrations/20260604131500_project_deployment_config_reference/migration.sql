ALTER TABLE "Project" ADD COLUMN "deployment_pr_target_branch" TEXT;
ALTER TABLE "Project" ADD COLUMN "deployment_pipeline_name" TEXT;
ALTER TABLE "Project" ADD COLUMN "deployment_host" TEXT;
ALTER TABLE "Project" ADD COLUMN "deployment_environment" TEXT;

UPDATE "Project"
SET
  "deployment_provider" = 'bitbucket',
  "deployment_production_branch" = 'main',
  "deployment_pr_target_branch" = 'main',
  "deployment_mode" = 'script',
  "deployment_on_merge" = './ai/openclaw/bin/deploy-on-merge',
  "deployment_host" = 'x1',
  "deployment_environment" = 'production'
WHERE "slug" = 'environment';
