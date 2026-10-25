// Runs once when a Next.js server instance starts (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
//
// Starts the ERP pull collector (src/lib/erp/pull.ts): this deployment
// has no cron of its own, and the ERP's pushes are being refused by
// the host's network layer, so the CRM collects waiting ERP events
// itself every 30 seconds. Node runtime only; edge has no timers.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { pullConfig, startErpPull } = await import('./lib/erp/pull');
  const cfg = pullConfig();
  if (!cfg) return;
  // The collected batch goes through the normal webhook handler, so
  // auth, dedupe, the ledger and sending behave exactly as for a push.
  const { POST } = await import('./app/api/erp/events/route');
  startErpPull(cfg, {
    fetch,
    handle: async (rawBody, signature, apiKey) => {
      const res = await POST(
        new Request('http://localhost/api/erp/events', {
          method: 'POST',
          body: rawBody,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'x-erp-signature': signature,
          },
        }),
      );
      let json: unknown = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json };
    },
  });
}
