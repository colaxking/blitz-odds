// The ONLY v1 (Lambda-handler) function in this repo, and it exists for one
// reason: context.clientContext.identity.token.
//
// Netlify injects an Identity SERVICE token into clientContext for functions
// using the old handler signature. Modern v2 "export default" functions never
// receive it - the same v1-only mechanism lib/auth.mts already documents for
// clientContext.user. Everything else here is v2, so the admin functions had
// no service token and fell back to the caller's own JWT.
//
// That fallback cannot work. GoTrue's /admin routes require the caller to
// hold the admin role, and the whole point of the console is to grant that
// role to the first admin, who by definition does not have it yet. The result
// was a 401 on the Users tab with no way forward: the seed admin was
// authorised by our code and rejected by GoTrue.
//
// So this file is a narrow proxy. Our v2 functions POST to it with an
// internal secret, it re-issues the request against GoTrue using the service
// token, and returns the response verbatim.
//
// WHY IT IS SAFE TO HAVE A SERVICE-TOKEN PROXY SITTING HERE:
//  - It is unreachable without INTERNAL_PROXY_SECRET, which is generated at
//    build time and never leaves the server.
//  - It only forwards paths beginning /admin/, so it cannot be steered at
//    arbitrary origins.
//  - It never returns the token itself, only the result of using it.
//
// If Netlify ever populates the service token for v2 functions, this file and
// the branch in lib/admin.mts that calls it can both be deleted.

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }

  const expected = process.env.INTERNAL_PROXY_SECRET;
  if (!expected) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "INTERNAL_PROXY_SECRET is not set" }) };
  }
  if (event.headers["x-internal-proxy-secret"] !== expected) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: "Unauthorized" }) };
  }

  const identity = context.clientContext && context.clientContext.identity;
  if (!identity || !identity.token) {
    return {
      statusCode: 503,
      body: JSON.stringify({
        ok: false,
        error: "No Identity service token in clientContext - is Identity enabled on this site?",
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Body must be JSON" }) };
  }

  const path = String(payload.path || "");
  // Anchored, and rejects traversal - this proxy holds a service token and
  // must never be usable as a general-purpose fetcher.
  if (!path.startsWith("/admin/") || path.indexOf("..") !== -1) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Only /admin/ paths are proxied" }) };
  }

  try {
    const res = await fetch(`${identity.url}${path}`, {
      method: payload.method || "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${identity.token}`,
      },
      body: payload.body ? JSON.stringify(payload.body) : undefined,
    });

    const text = await res.text();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      // The upstream status is carried in the envelope rather than as this
      // response's status, so a 404 from GoTrue stays distinguishable from a
      // failure of the proxy itself.
      body: JSON.stringify({ ok: true, status: res.status, body: text }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "Proxy request failed" }),
    };
  }
};
