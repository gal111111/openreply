import {expect,it} from "vitest";
import {reconcilePrivateMessage} from "@/lib/meta/serrini-reconciliation";
const expected={accountId:"owner",body:"resource",createdAt:new Date("2026-11-06T04:39:20Z"),updatedAt:new Date("2026-11-06T04:39:25Z")};
const sent={id:"receipt",message:"resource",from:{id:"owner"},created_time:"2026-11-06T04:39:23Z"};
it("reconciles a unique actual outbound during the reserved attempt",()=>expect(reconcilePrivateMessage([sent],expected)?.id).toBe("receipt"));
it.each([{...sent,from:{id:"recipient"}},{...sent,message:"another resource"},{...sent,created_time:"2026-11-05T04:39:23Z"},{...sent,created_time:"2026-11-07T04:39:23Z"},{...sent,id:""}])("holds insufficient or mismatched platform evidence",m=>expect(reconcilePrivateMessage([m],expected)).toBeNull());
it("does not choose arbitrarily between two matching sends",()=>expect(reconcilePrivateMessage([sent,{...sent,id:"second"}],expected)).toBeNull());
