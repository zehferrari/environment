CREATE TABLE "AttachmentExtract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceAttachmentId" TEXT,
    "sha256" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "text" TEXT,
    "summary" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "AttachmentExtract_sha256_extractorVersion_key" ON "AttachmentExtract"("sha256", "extractorVersion");
CREATE INDEX "AttachmentExtract_sourceAttachmentId_idx" ON "AttachmentExtract"("sourceAttachmentId");
CREATE INDEX "AttachmentExtract_status_idx" ON "AttachmentExtract"("status");
