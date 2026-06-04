ALTER TABLE "DeploymentPullRequest" ADD COLUMN "merge_sha" TEXT;
ALTER TABLE "DeploymentPullRequest" ADD COLUMN "deployment_exit_code" INTEGER;
ALTER TABLE "DeploymentPullRequest" ADD COLUMN "deployment_stdout" TEXT;
ALTER TABLE "DeploymentPullRequest" ADD COLUMN "deployment_stderr" TEXT;
ALTER TABLE "DeploymentPullRequest" ADD COLUMN "deployment_reported_at" DATETIME;
