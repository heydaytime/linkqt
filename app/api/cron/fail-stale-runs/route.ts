import { ensureSchema, failStalePendingRuns } from "../../../../lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (process.env.VERCEL_ENV === "production" && !secret) {
    return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
  }
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
  }
  await ensureSchema();
  await failStalePendingRuns();
  return Response.json({ ok: true });
}
