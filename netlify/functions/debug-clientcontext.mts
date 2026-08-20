import type { Context, Config } from "@netlify/functions";

// TEMPORARY debug endpoint - delete once the league-create/leagues-mine
// "Unauthorized" issue is diagnosed. Echoes back exactly what this function
// invocation received: whether an Authorization header arrived at all, and
// what (if anything) Netlify decoded into context.clientContext.user.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const authHeader = req.headers.get("authorization");
  const clientContext = (context as any).clientContext || null;

  return new Response(
    JSON.stringify(
      {
        hasAuthHeader: !!authHeader,
        authHeaderPreview: authHeader ? `${authHeader.slice(0, 24)}...` : null,
        clientContextPresent: !!clientContext,
        clientContextKeys: clientContext ? Object.keys(clientContext) : [],
        user: clientContext ? clientContext.user || null : null,
        identity: clientContext && clientContext.identity ? { url: clientContext.identity.url } : null,
      },
      null,
      2
    ),
    { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
};

export const config: Config = {
  path: "/.netlify/functions/debug-clientcontext",
};
