ALTER TABLE "ActionPlan" ADD COLUMN "reviewedAt" DATETIME;
ALTER TABLE "ActionPlan" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "ActionPlan" ADD COLUMN "delegatedApproverId" TEXT;
ALTER TABLE "ActionPlan" ADD COLUMN "delegatedById" TEXT;
