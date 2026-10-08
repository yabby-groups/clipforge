import { NextRequest, NextResponse } from "next/server";
import { beginDeviceAuthorization, HUABOT_SESSION_COOKIE, newSession } from "@/lib/huabot-oauth";
export async function POST(request: NextRequest) {
  try { const id = await newSession(); const device = await beginDeviceAuthorization(id); const response = NextResponse.json({ userCode: device.userCode, verificationUriComplete: device.verificationUriComplete, interval: device.interval }); const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https"; response.cookies.set(HUABOT_SESSION_COOKIE, id, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 31 * 24 * 60 * 60 }); return response; }
  catch { return NextResponse.json({ error: "Unable to start Huabot login. Check secure storage configuration." }, { status: 503 }); }
}
