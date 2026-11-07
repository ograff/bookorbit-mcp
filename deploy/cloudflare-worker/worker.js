// bookorbit-mcp-proxy: the public face of the MCP server for claude.ai connectors.
//
// A connector can send a plain `x-api-key` header but cannot complete an Access challenge or send
// Access service-token headers. This Worker checks the key and adds the service-token headers,
// then calls the Access-protected origin. Same pattern as the cluster's `k8s-mcp-proxy`.
//
// Variables (Workers > Settings > Variables and Secrets):
//   PROXY_KEY             secret  the value connectors send in x-api-key
//   ACCESS_CLIENT_ID      secret  Access service token Client ID
//   ACCESS_CLIENT_SECRET  secret  Access service token Client Secret
//   ORIGIN                var     https://bookorbit-mcp.<domain>   (no trailing slash)
const enc = new TextEncoder();
async function safeEq(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha),
    y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    // Fail closed if misconfigured: an unset key must never match anything a client can send.
    if (
      !env.PROXY_KEY ||
      !env.ACCESS_CLIENT_ID ||
      !env.ACCESS_CLIENT_SECRET ||
      !env.ORIGIN
    ) {
      return new Response("proxy not configured", { status: 500 });
    }
    const presented = request.headers.get("x-api-key") || "";
    if (!(await safeEq(presented, env.PROXY_KEY))) {
      return new Response("unauthorized", { status: 401 });
    }
    const h = new Headers(request.headers);
    h.delete("x-api-key");
    h.set("CF-Access-Client-Id", env.ACCESS_CLIENT_ID);
    h.set("CF-Access-Client-Secret", env.ACCESS_CLIENT_SECRET);
    return fetch(
      new Request(env.ORIGIN + "/mcp" + url.search, {
        method: request.method,
        headers: h,
        body: request.body,
        redirect: "manual",
      }),
    );
  },
};
