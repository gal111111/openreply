ALTER TABLE "InstagramAccount"
  ADD COLUMN "metaLoginMode" TEXT NOT NULL DEFAULT 'INSTAGRAM',
  ADD COLUMN "metaAppId" TEXT,
  ADD COLUMN "metaBusinessId" TEXT,
  ADD COLUMN "metaConfigId" TEXT;

CREATE TABLE "InstagramReplySuppression" (
  "id" TEXT NOT NULL,
  "instagramAccountId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "inboundId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstagramReplySuppression_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InstagramReplySuppression_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InstagramReplySuppression_instagramAccountId_senderId_key" ON "InstagramReplySuppression"("instagramAccountId", "senderId");
