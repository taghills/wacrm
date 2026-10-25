// Node-runtime start-up jobs, imported by src/instrumentation.ts.
//
// The ERP pull collector (src/lib/erp/pull.ts): this deployment has no
// cron of its own, and the ERP's pushes are being refused by the host's
// network layer, so the CRM collects waiting ERP events itself every
// 30 seconds.

import { pullConfig, startErpPull } from './lib/erp/pull';
import { POST as handleErpEvents } from './app/api/erp/events/route';

export async function startNodeJobs() {
  const cfg = pullConfig();
  if (!cfg) return;
  // The collected batch goes through the normal webhook handler, so
  // auth, dedupe, the ledger and sending behave exactly as for a push.
  startErpPull(cfg, {
    fetch,
    handle: async (rawBody, signature, apiKey) => {
      const res = await handleErpEvents(
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
