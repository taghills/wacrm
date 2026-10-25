// Runs once when a Next.js server instance starts (see
// node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
//
// Node-only work lives in instrumentation-node.ts and is imported
// inside the NEXT_RUNTIME check, the documented pattern: the bundler
// drops that import from the edge build (it pulls in node:net via the
// ERP event handler, which the edge runtime cannot load).

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startNodeJobs } = await import('./instrumentation-node');
    await startNodeJobs();
  }
}
