import { beforeEach, describe, expect, it, vi } from "vitest";
const findFirst=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/db/client",()=>({prisma:{operationalEvent:{findFirst}}}));
import { getResourceHistory, historyAllows, type ResourceHistory } from "@/lib/meta/serrini-history";
const history:ResourceHistory={postId:"post1",messageHash:"hash",key:"ECC",campaignId:"c1",heldNames:["already.sent"],heldIds:["old-id"]};
beforeEach(()=>vi.clearAllMocks());
describe("Serrini resource history delivery boundary",()=>{
 it("holds unknown or incomplete recipient identities",()=>{expect(historyAllows(undefined,"new","id")).toBe(false);expect(historyAllows(history,undefined,"id")).toBe(false);expect(historyAllows(history,"new",undefined)).toBe(false)});
 it("holds both historic handles and API identities without faking SENT",()=>{expect(historyAllows(history,"@ALREADY.SENT","changed-id")).toBe(false);expect(historyAllows(history,"renamed","old-id")).toBe(false);expect(historyAllows(history,"new","new-id")).toBe(true)});
 it("does not borrow another campaign's resource history",async()=>{findFirst.mockResolvedValue({payload:{identityVerified:true,resources:[history]}});expect(await getResourceHistory("w","a","other")).toBeUndefined();expect(findFirst.mock.calls[0][0].where).toMatchObject({workspaceId:"w",payload:{path:["accountId"],equals:"a"}})});
 it("requires actual identity preparation",async()=>{findFirst.mockResolvedValue({payload:{identityVerified:false,resources:[history]}});expect(await getResourceHistory("w","a","c1")).toBeUndefined()});
});
