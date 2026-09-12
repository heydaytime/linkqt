import { handleLinkqtRequest } from "../../../lib/server/linkqt-api";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleLinkqtRequest(request);
}

export function POST(request: Request) {
  return handleLinkqtRequest(request);
}

export function OPTIONS(request: Request) {
  return handleLinkqtRequest(request);
}
