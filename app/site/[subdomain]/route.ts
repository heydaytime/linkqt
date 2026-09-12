import { htmlDocument, notFoundDocument, publishedDocument } from "../../../lib/server/linkqt-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ subdomain: string }> }) {
  const { subdomain } = await context.params;
  try {
    const deployment = await publishedDocument(subdomain);
    if (!deployment) return htmlDocument(notFoundDocument(subdomain), 404);
    return htmlDocument(deployment.document);
  } catch {
    return htmlDocument(errorDocument(), 502);
  }
}

function errorDocument() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Could not load LinkQT page</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; color: #171717; }
      main { max-width: 32rem; text-align: center; }
      h1 { margin: 0; font-size: 2rem; letter-spacing: -0.04em; }
      p { color: #737373; line-height: 1.6; }
    </style>
  </head>
  <body><main><h1>Could not load this page</h1><p>Please try again later.</p></main></body>
</html>`;
}
