import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { processInstagramWebhook } from "@/lib/queue/process-webhook";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const expected = process.env.SERRINI_WEBHOOK_VERIFY_TOKEN;
  if (
    expected &&
    params.get("hub.mode") === "subscribe" &&
    params.get("hub.verify_token") === expected
  ) {
    return new NextResponse(params.get("hub.challenge"), { status: 200 });
  }
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  const secret = process.env.SERRINI_META_APP_SECRET;
  const appId = process.env.SERRINI_META_APP_ID;
  if (!secret || !appId)
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";
  const expected =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (payload?.object !== "instagram" || !Array.isArray(payload.entry)) {
    return NextResponse.json(
      { error: "Invalid Instagram payload" },
      { status: 400 },
    );
  }
  try {
    await processInstagramWebhook({
      payload,
      provider: "META",
      metaAppId: appId,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 },
    );
  }
}
