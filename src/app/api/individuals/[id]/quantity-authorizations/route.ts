import { NextRequest, NextResponse } from "next/server";
import { getHourAuthorizationOperator } from "@/lib/auth/hour-authorization-access";
import { hasDirectIndividualAccess } from "@/lib/auth/access";
import { changeQuantityAuthorization, listQuantityAuthorizations } from "@/lib/manage/quantity-authorizations";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{id:string}> };
export async function GET(_request: NextRequest, {params}:Context) {
 const operator=await getHourAuthorizationOperator(); const {id}=await params;
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return jsonError("Invalid individual identity.",400);
 if(!operator || !hasDirectIndividualAccess(operator.scope,id)) return jsonError("Budget planning access required for this individual.",403);
 try{return NextResponse.json({ok:true,data:await listQuantityAuthorizations(operator.pool,id)});}
 catch(error){return jsonError(redactError(error,"Could not load quantity authorizations."),500);}
}
export async function POST(request:NextRequest,{params}:Context){
 const origin=sameOriginOrFail(request); if(origin)return origin;
 const operator=await getHourAuthorizationOperator(); const {id}=await params;
 if(!operator || !hasDirectIndividualAccess(operator.scope,id)) return jsonError("Budget planning access required for this individual.",403);
 try{return resultResponse(await changeQuantityAuthorization(operator.pool,id,await readJson(request),operator.user.actorId));}
 catch(error){return jsonError(redactError(error,"Could not save quantity authorization."),500);}
}
