import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { createInstagramContext } from "@/lib/instagram/context";
import { getAllUserMedia, getUserInfo, getConversations, getConversationMessages, getRecentMediaComments, subscribeInstagramAccountToWebhooks } from "@/lib/meta/client";
import { getDMQueue } from "@/lib/queue/client";
import { HISTORY_EVENT, SERRINI_IDS, getResourceHistory, historyAllows, type ResourceHistory } from "@/lib/meta/serrini-history";
import { isStopRequest, suppressSerriniSender } from "@/lib/meta/serrini-suppression";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

export const dynamic = "force-dynamic";
const resourceSchema = z.object({ key: z.enum(["ECC","COUNCIL","AI","SCRIPT","EDITOR","BROCHURE","EVENT"]), shortcode: z.string().regex(/^[A-Za-z0-9_-]+$/), keywords: z.array(z.string().min(1).max(50)).min(1).max(10), message: z.string().min(1).max(1000), guideMarkers: z.array(z.string().min(5)).min(1).max(3), heldNames: z.array(z.string().regex(/^[a-zA-Z0-9_.]+$/)).max(200).default([]) });
const bodySchema = z.object({ action: z.enum(["prepare","activate","backfill"]), account: z.enum(["serrinion","serrini666"]), resources: z.array(resourceSchema).max(7).optional() });
const ids: Record<string,string> = {serrinion:"17841415718399486",serrini666:"17841480865798985"};
function reply(data: unknown, status=200) { return NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}}); }

export async function GET() {
  const context=await getCurrentWorkspaceContext();
  if(!context || !canManageWorkspace(context.role)) return reply({error:"Administrator required"},403);
  const accounts=await prisma.instagramAccount.findMany({where:{workspaceId:context.workspaceId,instagramId:{in:[...SERRINI_IDS]}},select:{id:true,username:true,instagramId:true,webhookSubscribed:true,tokenExpiresAt:true}});
  const campaigns=await prisma.automation.findMany({where:{workspaceId:context.workspaceId,sourceSystem:"serrini-resource-v1"},select:{id:true,name:true,isActive:true,postId:true,postUrl:true,instagramAccountId:true,dmMessage:true,publicReplyMessages:true}});
  const logs=await prisma.dmLog.findMany({where:{workspaceId:context.workspaceId,automationId:{in:campaigns.map(c=>c.id)}},orderBy:{createdAt:"desc"},take:100,select:{id:true,commentId:true,commenterName:true,status:true,dmSentAt:true,dmDeliveryUnconfirmed:true,publicReplySentAt:true,publicReplyDeliveryUnconfirmed:true,errorMessage:true,publicReplyError:true}});
  const history=await prisma.operationalEvent.findMany({where:{workspaceId:context.workspaceId,message:HISTORY_EVENT},orderBy:{createdAt:"desc"},take:2,select:{createdAt:true,payload:true}});
  const receipts=await prisma.operationalEvent.findMany({where:{workspaceId:context.workspaceId,message:"Serrini private resource readback verified"},orderBy:{createdAt:"desc"},take:25,select:{createdAt:true,payload:true}});
  return reply({accounts,campaigns,logs,history,receipts});
}

export async function POST(request:NextRequest) {
  const context=await getCurrentWorkspaceContext();
  if(!context || !canManageWorkspace(context.role)) return reply({error:"Administrator required"},403);
  if(request.headers.get("origin") !== new URL(getBaseUrl()).origin) return reply({error:"Same-origin request required"},403);
  const parsed=bodySchema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success) return reply({error:"Invalid resource request"},400);
  const body=parsed.data;
  if (!process.env.SERRINI_META_APP_ID || !process.env.SERRINI_META_BUSINESS_ID) return reply({error:"Connector configuration unavailable"},409);
  const account=await prisma.instagramAccount.findFirst({where:{workspaceId:context.workspaceId,instagramId:ids[body.account],username:body.account,metaLoginMode:"UNIFIED",metaAppId:process.env.SERRINI_META_APP_ID,metaBusinessId:process.env.SERRINI_META_BUSINESS_ID}});
  if(!account || !account.tokenExpiresAt || account.tokenExpiresAt <= new Date()) return reply({error:"Verified Serrini connection required"},409);
  const connection=await createInstagramContext(account);
  if(connection.provider!=="META") return reply({error:"Official Meta connection required"},409);
  const token=connection.accessToken;
  try {
    const profile=await getUserInfo(token);
    if(profile.id!==account.instagramId || profile.username.toLowerCase()!==body.account) throw new Error("Identity mismatch");
    if(body.action==="prepare") {
      if(!body.resources?.length) return reply({error:"Resource manifest required"},400);
      // Preparation disables existing matching campaigns before any history read.
      await prisma.automation.updateMany({where:{instagramAccountId:account.id,sourceSystem:"serrini-resource-v1"},data:{isActive:false}});
      if (!account.webhookSubscribed) {
        const subscribed=await subscribeInstagramAccountToWebhooks(account.instagramId,token);
        if(subscribed.success!==true) throw new Error("Webhook subscription not confirmed");
        await prisma.instagramAccount.update({where:{id:account.id},data:{webhookSubscribed:true}});
      }
      const media=await getAllUserMedia(token);
      const conversations=await getConversations(token,account.instagramId);
      if(conversations.length>=50 || conversations.some(c=>c.detailsUnavailable)) throw new Error("History requires further pagination or unavailable conversation review");
      const manualHolds=new Set(body.resources.flatMap(r=>r.heldNames.map(n=>n.toLowerCase())));
      const knownMarkers=body.resources.flatMap(r=>r.guideMarkers);
      const historical: {name:string;id:string;outbound:string[];incomplete:boolean}[]=[];
      for(const conversation of conversations) {
        const participant=conversation.participants?.data.find(p=>p.id!==account.instagramId);
        if(!participant?.id || !participant.username) throw new Error("Conversation identity unavailable");
        // A verified manual hold cannot send; its API participant identity is
        // sufficient to preserve the exclusion without re-reading the thread.
        const messages=manualHolds.has(participant.username.toLowerCase())
          ? conversation.messages?.data??[]
          : await getConversationMessages(token,conversation.id);
        for(const m of messages) if(m.from?.id===participant.id && isStopRequest(m.message??"")) await suppressSerriniSender(account.id,participant.id,m.id);
        historical.push({name:participant.username.toLowerCase(),id:participant.id,outbound:messages.filter(m=>m.from?.id===account.instagramId).map(m=>m.message??""),incomplete:messages.length>=20});
      }
      const resources:ResourceHistory[]=[];
      for(const resource of body.resources) {
        const post=media.find(m=>m.permalink?.split('/').includes(resource.shortcode));
        if(!post) throw new Error(`Own source post unavailable: ${resource.key}`);
        const previous=await prisma.automation.findUnique({where:{externalId:`serrini-resource-v1:${account.instagramId}:${resource.key}`}});
        const priorHistory=previous ? await getResourceHistory(context.workspaceId,account.id,previous.id) : undefined;
        const heldNames=new Set([...resource.heldNames.map(n=>n.toLowerCase()),...(priorHistory?.heldNames??[])]);
        const heldIds=new Set<string>(priorHistory?.heldIds??[]);
        for(const h of historical) {
          const gotResource=h.outbound.some(text=>resource.guideMarkers.some(marker=>text.includes(marker)));
          // Ambiguous historic outbound is held for review, never resent as if history were empty.
          if(gotResource || h.incomplete || h.outbound.some(text=>text.trim() && !knownMarkers.some(marker=>text.includes(marker)))) { heldNames.add(h.name);heldIds.add(h.id); }
          if(heldNames.has(h.name)) heldIds.add(h.id);
        }
        const externalId=`serrini-resource-v1:${account.instagramId}:${resource.key}`;
        const fields={name:`${body.account} · ${resource.key} · 留言私訊`,postId:post.id,postUrl:post.permalink,keywords:resource.keywords,dmMessage:resource.message,publicReplyEnabled:true,publicReplyMessages:["發給你啦","私信你啦"],publicReplyMessage:null,wholeWordMatch:false,matchAnyPost:false,matchAnyWord:false,dmTriggerEnabled:false,requireFollow:false,openingDmEnabled:false,followUpEnabled:false,isActive:false,sourceSystem:"serrini-resource-v1",sourceRef:createHash("sha256").update(JSON.stringify(resource)).digest("hex")};
        const campaign=await prisma.automation.upsert({where:{externalId},create:{...fields,externalId,workspaceId:context.workspaceId,instagramAccountId:account.id},update:fields});
        resources.push({postId:post.id,messageHash:createHash("sha256").update(resource.message).digest("hex"),key:resource.key,campaignId:campaign.id,heldNames:[...heldNames],heldIds:[...heldIds]});
      }
      await prisma.operationalEvent.create({data:{workspaceId:context.workspaceId,source:"SYSTEM",message:HISTORY_EVENT,payload:{accountId:account.id,resources,preparedAt:new Date().toISOString(),identityVerified:true,conversationsChecked:historical.length,manualHoldsPreserved:true}}});
      return reply({prepared:true,account:body.account,conversationsChecked:historical.length,resources,campaignsActive:false});
    }
    const campaigns=await prisma.automation.findMany({where:{instagramAccountId:account.id,sourceSystem:"serrini-resource-v1"}});
    if(!campaigns.length || !account.webhookSubscribed) return reply({error:"Prepare history and webhook first"},409);
    for(const c of campaigns) {
      const history=await getResourceHistory(context.workspaceId,account.id,c.id);
      if(!history || history.postId!==c.postId || history.messageHash!==createHash("sha256").update(c.dmMessage).digest("hex")) return reply({error:"Historical exclusions missing or source changed"},409);
    }
    if(body.action==="activate") {
      await prisma.automation.updateMany({where:{id:{in:campaigns.map(c=>c.id)},workspaceId:context.workspaceId},data:{isActive:true}});
      return reply({active:campaigns.length,account:body.account});
    }
    let queued=0,held=0,seen=0;
    for(const c of campaigns.filter(c=>c.isActive)) {
      const history=await getResourceHistory(context.workspaceId,account.id,c.id);
      const comments=await getRecentMediaComments(token,c.postId!,Date.now()-7*86400000,2000);
      if(comments.length>=2000) throw new Error("Comment safety bound reached; completeness not confirmed");
      for(const comment of comments) {
        if(!matchKeywords(comment.text??"",c.keywords,false).matched) continue;
        seen++;
        const name=comment.from?.username??comment.username;
        if(!historyAllows(history,name,comment.from?.id) || comment.from?.id===account.instagramId) {held++;continue;}
        const old=await prisma.dmLog.findFirst({where:{instagramAccountId:account.id,OR:[{commentId:comment.id},{automationId:c.id,commenterId:comment.from!.id,status:"SENT"}]}});
        if(old) {held++;continue;}
        if(queued>=10) continue;
        await getDMQueue().add("process-comment",{accountConnectionId:account.id,instagramAccountId:account.instagramId,mediaId:c.postId!,commentId:comment.id,commentText:comment.text??"",commenterId:comment.from!.id,commenterName:name,source:"POLLING"},{jobId:`comment_${account.instagramId}_${comment.id}`});queued++;
      }
    }
    return reply({queued,held,matched:seen,complete:false,note:"Queued is not sent; inspect verified platform receipts."});
  } catch(error) {
    // Graph errors may carry request details: only fixed code/name leaves this route.
    return reply({error:"Serrini reconciliation failed",category:error instanceof Error ? error.name : "unknown",code:typeof error==="object" && error && "code" in error ? error.code : null},502);
  }
}
