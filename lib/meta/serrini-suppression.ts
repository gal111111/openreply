import { prisma } from "@/lib/db/client";

export function isStopRequest(text: string): boolean {
  return (
    /停止|不要再(?:發|发|傳|传|回覆|回复)|退訂|退订|取消訂閱|取消订阅/i.test(
      text,
    ) ||
    /^(?:stop|unsubscribe|opt[ -]?out)[.!\s]*$/i.test(text.trim()) ||
    /\bstop (?:sending|messaging|replying|contacting)\b/i.test(text)
  );
}

export async function suppressSerriniSender(
  accountId: string,
  senderId: string,
  inboundId: string,
) {
  await prisma.instagramReplySuppression.upsert({
    where: {
      instagramAccountId_senderId: { instagramAccountId: accountId, senderId },
    },
    create: { instagramAccountId: accountId, senderId, inboundId },
    update: { inboundId },
  });
}
