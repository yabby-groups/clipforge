import { NextRequest, NextResponse } from "next/server";
import { HUABOT_SESSION_COOKIE, revokeAndRemove } from "@/lib/huabot-oauth";
export async function POST(request: NextRequest) { await revokeAndRemove(request.cookies.get(HUABOT_SESSION_COOKIE)?.value); const response = NextResponse.json({ ok: true }); const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https"; response.cookies.set(HUABOT_SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 }); return response; }
