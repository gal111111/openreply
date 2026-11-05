import { prisma } from "@/lib/db/client";

export function isStopRequest(text: string): boolean {
  const request = text.trim();
  return (
    /^(?:請|请|我要|我想)?\s*(?:停止|退訂|退订|取消訂閱|取消订阅)[！!。.\s]*$/i.test(request) ||
    /^(?:請|请)?\s*(?:停止|不要再|別再|别再)(?:自動|自动)?(?:回覆|回复|發送|发送|傳訊|传讯|聯絡|联系|發|发|傳|传)(?:給我|给我|我)?(?:[\s，。！!]|$)/i.test(request) ||
    /^(?:stop|unsubscribe|opt[ -]?out)[.!\s]*$/i.test(request) ||
    /\bstop (?:sending|messaging|replying|contacting)\b/i.test(request)
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
