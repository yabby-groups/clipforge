import { NextRequest, NextResponse } from "next/server";
import { HUABOT_SESSION_COOKIE, listHuabotKeys, loadSession, pollDeviceAuthorization } from "@/lib/huabot-oauth";
export async function GET(request: NextRequest) {
  const id = request.cookies.get(HUABOT_SESSION_COOKIE)?.value; const session = await loadSession(id);
  if (!session) return NextResponse.json({ state: "signed_out" });
  if (session.tokens) {
    try { return NextResponse.json({ state: "authorized", profile: session.profile, keys: await listHuabotKeys(id).then((keys) => keys.map(({ id, name, masked }) => ({ id, name, masked }))) }); }
    catch (error) { return NextResponse.json({ state: "error", message: error instanceof Error ? error.message : "Unable to load Huabot keys" }, { status: 502 }); }
  }
  const result = await pollDeviceAuthorization(id!, session); return NextResponse.json({ state: result.state, retryAfter: result.retryAfter, message: result.message, profile: result.session?.profile });
}
