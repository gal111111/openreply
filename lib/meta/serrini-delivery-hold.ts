import { prisma } from "@/lib/db/client";

/** An uncertain send needs reconciliation; a restriction gets a one-hour backoff. */
export async function hasSerriniDeliveryHold(accountId: string): Promise<boolean> {
  return Boolean(await prisma.dmLog.findFirst({
    where: {
      instagramAccountId: accountId,
      status: "FAILED",
      OR: [
        { dmDeliveryUnconfirmed: true },
        {
          updatedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
          OR: ["RateLimitError", " 4:", " 17:", " 32:", " 368:", " 613:", " 429:", "code=4 ", "code=17 ", "code=32 ", "code=368 ", "code=613 ", "code=429 "]
            .map(code => ({ errorMessage: { contains: code } })),
        },
      ],
    },
    select: { id: true },
  }));
}
