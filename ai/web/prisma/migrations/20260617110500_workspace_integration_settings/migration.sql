-- Workspace-level defaults are nullable so existing project/system settings remain authoritative.
ALTER TABLE "Workspace" ADD COLUMN "default_git_user_name" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "default_git_user_email" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "done_ttl_days" INTEGER;
ALTER TABLE "Workspace" ADD COLUMN "deployment_provider" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_production_branch" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_pr_target_branch" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_mode" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_on_merge" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_pipeline_name" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_host" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_environment" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_bitbucket_workspace" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "deployment_bitbucket_repo_slug" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "integration_defaults" TEXT;
ALTER TABLE "Project" ADD COLUMN "integration_defaults" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "integration_defaults" TEXT;
