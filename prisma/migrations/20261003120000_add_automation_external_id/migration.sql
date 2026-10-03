-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "sourceSystem" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Automation_externalId_key" ON "Automation"("externalId");

