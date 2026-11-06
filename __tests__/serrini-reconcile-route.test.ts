import {beforeEach,expect,it,vi} from "vitest";
import {NextRequest} from "next/server";
const mocks=vi.hoisted(()=>({context:vi.fn(),account:vi.fn(),profile:vi.fn(),update:vi.fn(),subscribe:vi.fn(),allMedia:vi.fn(),conversations:vi.fn(),contextCreate:vi.fn(),campaigns:vi.fn(),oldLog:vi.fn(),history:vi.fn(),comments:vi.fn(),enqueue:vi.fn()}));
vi.mock("@/lib/workspace-access",()=>({getCurrentWorkspaceContext:mocks.context,canManageWorkspace:(role:string)=>role==="OWNER"||role==="ADMIN"}));
vi.mock("@/lib/db/client",()=>({prisma:{instagramAccount:{findFirst:mocks.account},automation:{updateMany:mocks.update,findMany:mocks.campaigns},dmLog:{findFirst:mocks.oldLog}}}));
vi.mock("@/lib/meta/client",()=>({getUserInfo:mocks.profile,subscribeInstagramAccountToWebhooks:mocks.subscribe,getAllUserMedia:mocks.allMedia,getConversations:mocks.conversations,getRecentMediaComments:mocks.comments}));
vi.mock("@/lib/instagram/context",()=>({createInstagramContext:mocks.contextCreate}));
vi.mock("@/lib/queue/client",()=>({getDMQueue:()=>({add:mocks.enqueue})}));
vi.mock("@/lib/meta/serrini-history",()=>({SERRINI_IDS:new Set(["17841480865798985"]),getResourceHistory:mocks.history,historyAllows:()=>true}));
import {POST} from "@/app/api/instagram/serrini/reconcile/route";
const request=(origin="https://openreply.up.railway.app")=>new NextRequest("https://openreply.up.railway.app/api/instagram/serrini/reconcile",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({action:"prepare",account:"serrini666",resources:[{key:"ECC",shortcode:"test",keywords:["ECC"],message:"approved",guideMarkers:["guide123"]}]})});
beforeEach(()=>{vi.clearAllMocks();process.env.NEXTAUTH_URL="https://openreply.up.railway.app";process.env.SERRINI_META_APP_ID="expected";process.env.SERRINI_META_BUSINESS_ID="business";mocks.context.mockResolvedValue({role:"OWNER",workspaceId:"w"});mocks.account.mockResolvedValue({id:"a",instagramId:"17841480865798985",username:"serrini666",tokenExpiresAt:new Date(Date.now()+100000)});mocks.contextCreate.mockResolvedValue({provider:"META",accessToken:{instagramId:"17841480865798985",accessToken:"fake",loginMode:"UNIFIED"}})});
it("rejects a non-admin without looking up account credentials",async()=>{mocks.context.mockResolvedValue({role:"MEMBER",workspaceId:"w"});expect((await POST(request())).status).toBe(403);expect(mocks.account).not.toHaveBeenCalled()});
it("rejects cross-origin writes before account access",async()=>{expect((await POST(request("https://elsewhere.example"))).status).toBe(403);expect(mocks.account).not.toHaveBeenCalled()});
it("does not proceed with a mismatched actual account identity",async()=>{mocks.profile.mockResolvedValue({id:"wrong",username:"serrini666"});expect((await POST(request())).status).toBe(502);expect(mocks.update).not.toHaveBeenCalled();expect(mocks.subscribe).not.toHaveBeenCalled()});
it("keeps campaigns disabled when webhook subscription fails",async()=>{mocks.profile.mockResolvedValue({id:"17841480865798985",username:"serrini666"});mocks.subscribe.mockRejectedValue(new Error("not confirmed"));expect((await POST(request())).status).toBe(502);expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({data:{isActive:false}}));expect(mocks.allMedia).not.toHaveBeenCalled()});

it("accepts the configured public origin behind Railway internal proxy",async()=>{mocks.profile.mockResolvedValue({id:"wrong",username:"serrini666"});const req=new NextRequest("http://localhost:3000/api/instagram/serrini/reconcile",{method:"POST",headers:{Origin:"https://openreply.up.railway.app","Content-Type":"application/json"},body:JSON.stringify({action:"prepare",account:"serrini666",resources:[{key:"ECC",shortcode:"test",keywords:["ECC"],message:"approved",guideMarkers:["guide123"]}]})});expect((await POST(req)).status).toBe(502);expect(mocks.account).toHaveBeenCalled()});

it("backfills only two fresh requests, spaces them, and preserves existing unknown/sent logs",async()=>{
 const {createHash}=await import("node:crypto");
 mocks.account.mockResolvedValue({id:"a",instagramId:"17841480865798985",username:"serrini666",tokenExpiresAt:new Date(Date.now()+100000),webhookSubscribed:true});
 mocks.profile.mockResolvedValue({id:"17841480865798985",username:"serrini666"});
 mocks.campaigns.mockResolvedValue([{id:"campaign",postId:"post",dmMessage:"approved",keywords:["ECC"],isActive:true}]);
 mocks.history.mockResolvedValue({postId:"post",messageHash:createHash("sha256").update("approved").digest("hex")});
 mocks.comments.mockResolvedValue(["sent","unknown","fresh1","fresh2","fresh3"].map(id=>({id,text:"ECC",from:{id:"recipient-"+id,username:id}})));
 mocks.oldLog.mockImplementation(async({where})=>["sent","unknown"].includes(where.OR[0].commentId)?{status:"SENT"}:null);
 const req=new NextRequest("https://openreply.up.railway.app/api/instagram/serrini/reconcile",{method:"POST",headers:{Origin:"https://openreply.up.railway.app","Content-Type":"application/json"},body:JSON.stringify({action:"backfill",account:"serrini666"})});
 const response=await POST(req);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({queued:2,held:2,batchLimit:2,spacingMs:60000,complete:false});
 expect(mocks.enqueue).toHaveBeenCalledTimes(2);
 expect(mocks.enqueue.mock.calls.map(c=>c[1].commentId)).toEqual(["fresh1","fresh2"]);
 expect(mocks.enqueue.mock.calls.map(c=>c[2].delay)).toEqual([0,60000]);
});
