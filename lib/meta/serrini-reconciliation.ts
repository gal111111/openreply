import type { InstagramMessage } from "./client";
export function reconcilePrivateMessage(messages:InstagramMessage[], expected:{accountId:string;body:string;createdAt:Date;updatedAt:Date}) {
 const candidates=messages.filter(m=>m.id && m.from?.id===expected.accountId && m.message===expected.body && m.created_time && Date.parse(m.created_time)>=expected.createdAt.getTime()-5000 && Date.parse(m.created_time)<=expected.updatedAt.getTime()+60000);
 return candidates.length===1 ? candidates[0] : null;
}
