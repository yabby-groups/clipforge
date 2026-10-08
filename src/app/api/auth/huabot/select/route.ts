import { NextRequest, NextResponse } from "next/server";
import { HUABOT_SESSION_COOKIE, listHuabotKeys } from "@/lib/huabot-oauth";
export async function POST(request: NextRequest) {
  try {
    const { id } = await request.json();
    const keys = await listHuabotKeys(request.cookies.get(HUABOT_SESSION_COOKIE)?.value);
    const key = keys.find((item) => item.id === Number(id));
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    return NextResponse.json({ id: key.id, name: key.name, apiKey: key.key });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load Huabot keys" }, { status: 502 });
  }
}
