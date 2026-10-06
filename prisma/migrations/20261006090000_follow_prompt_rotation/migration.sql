-- AlterTable
ALTER TABLE "Automation" ADD COLUMN "followPromptMessages" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "DmLog" ADD COLUMN "followPromptSentAt" TIMESTAMP(3);
