import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The one origin allowed to embed this app in an iframe: the TAGHills
 * ERP, whose "CRM" tab renders wa.taghills.com inline.
 *
 * Scheme and host only, no path — frame-ancestors matches origins.
 */
const ERP_ORIGIN = "https://erp.taghills.com";

/**
 * Baseline security headers applied to every response.
 *
 * CSP ships as `Content-Security-Policy-Report-Only` so the browser
 * surfaces violations in the console without blocking anything — once
 * we have confidence nothing legit trips it (two deploys, a pass on
 * every route), flip the key to `Content-Security-Policy` to enforce.
 *
 * The rest of the headers are straight blocks, safe to enforce today:
 *   - HSTS: only meaningful on HTTPS (no-op on http://localhost).
 *   - X-Content-Type-Options / Referrer-Policy: baseline OWASP
 *     hardening, no behavioural cost.
 *   - Permissions-Policy: we don't use camera / microphone / etc, so
 *     deny them. A supply-chain compromise or a forgotten plugin
 *     can't silently opt back in.
 *
 * Framing is the one exception to "CSP is report-only here". The ERP
 * at erp.taghills.com embeds this app in an iframe on its CRM tab, so
 * framing must be allowed for that one origin and refused for every
 * other. See FRAME_ANCESTORS below — it is a real, enforcing
 * Content-Security-Policy header carrying a single directive, kept
 * separate from the report-only policy above it.
 */
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Microphone is allowed for same-origin (`self`) so the inbox
    // composer can record voice notes via MediaRecorder. Everything
    // else stays denied — a compromised dependency can't silently grab
    // the camera / geolocation / etc.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      // Next.js needs 'unsafe-inline' for its inline hydration script
      // and 'unsafe-eval' in dev + some production optimisations.
      // Nonce-based CSP is a later project.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind + inline style attributes on lots of components.
      "style-src 'self' 'unsafe-inline'",
      // Supabase public-bucket avatars, contact avatars (arbitrary
      // https URLs paste-able from the UI), OG images, data URLs for
      // tiny inline assets.
      "img-src 'self' data: blob: https:",
      // Outbound media previews (blob: from MediaRecorder + file picker)
      // and Supabase public-bucket audio/video the inbox renders.
      "media-src 'self' blob: https://*.supabase.co",
      "font-src 'self' data:",
      // Supabase REST + realtime (WSS). All Meta API calls happen
      // server-side, so graph.facebook.com does not belong here.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      // Mirrors the enforced FRAME_ANCESTORS policy below. Left at
      // 'none' this would report a violation on every legitimate ERP
      // page view, which is exactly the noise report-only mode is
      // meant to make meaningful.
      `frame-ancestors ${ERP_ORIGIN}`,
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

/**
 * Framing policy, enforced (not report-only).
 *
 * This replaces `X-Frame-Options: DENY`, which used to sit in
 * SECURITY_HEADERS and was the header actually refusing the ERP's
 * iframe. X-Frame-Options cannot express "this one other origin" —
 * its ALLOW-FROM form was never implemented by Chrome and is dropped
 * from the spec — so allowing one origin means removing it and saying
 * the same thing in CSP instead.
 *
 * It has to be its own ENFORCED header rather than an edit to the
 * report-only policy above. Report-only does not block: with
 * X-Frame-Options gone and frame-ancestors only in a report-only
 * policy, ANY site could frame this app. Protection would be lost,
 * silently, while looking tightened.
 *
 * Kept to the single directive so enforcing it cannot accidentally
 * enforce the rest of the report-only policy, which is deliberately
 * still being observed rather than applied.
 */
const FRAME_ANCESTORS = {
  key: "Content-Security-Policy",
  value: `frame-ancestors ${ERP_ORIGIN}`,
};

const nextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the
  // Docker image can run without node_modules or the Next CLI.
  // Harmless outside Docker: `next start` keeps working as before.
  output: "standalone",

  /**
   * Cross-origin dev access (Next.js 16).
   *
   * Next 16 blocks requests to dev-only resources (`/_next/*` internals,
   * the HMR websocket, the dev overlay) unless the browser's Origin is
   * the host the dev server booted on — `localhost` by default. Tunnels
   * like ngrok serve the app from a public HTTPS host, so without
   * allow-listing that host those dev requests come back 403: HMR stops
   * working and the dev session degrades over the tunnel (issue #365).
   *
   * Wildcards match subdomains only (Next's CSRF matcher), so the
   * randomised tunnel subdomain is covered. Add any other host via
   * `ALLOWED_DEV_ORIGINS` (comma-separated). This key is dev-only and
   * has no effect on a production build.
   */
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
    "*.trycloudflare.com",
    "*.loca.lt",
    ...(process.env.ALLOWED_DEV_ORIGINS
      ? process.env.ALLOWED_DEV_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  ],

  /**
   * Cache-Control policy.
   *
   * Why this exists:
   *   Hostinger's CDN was applying `s-maxage=31536000` (1 year) to
   *   prerendered HTML pages by default. When a new deploy shipped
   *   fresh Turbopack chunk hashes, the edge kept serving year-old
   *   HTML referencing chunk filenames that no longer existed on
   *   disk — result: HTML 200, every /_next/static/*.js and .css
   *   came back 404, the page rendered unstyled. Private/incognito
   *   did nothing because the cache is server-side.
   *
   * The `public, s-maxage=300, stale-while-revalidate=86400` this
   * rule used to carry was the wrong lever, and it broke two ways:
   *
   *   1. Pages render as raw text. The App Router serves two
   *      different bodies at the SAME url — the HTML document, and
   *      the React flight payload a prefetch asks for — told apart
   *      only by the request's `RSC` header and the response's
   *      `Vary`. Marked `public`, a prefetch's flight payload is
   *      cacheable, and an edge that does not split on `Vary` then
   *      hands that payload to the next browser asking for the
   *      document. The browser has no HTML to render, so it prints
   *      the payload: lines of `I[520,[...]]` and `$L16` where the
   *      dashboard should be.
   *
   *   2. One signed-in user's page could be served to another.
   *      `public` invites a SHARED cache to store the response. Every
   *      page here is per-account and most are per-user, so a cache
   *      hit across two visitors is a data leak, not a stale page.
   *      The note that used to sit here — that Next.js and the auth
   *      middleware would still mark per-user responses private — was
   *      wrong: an explicit header from this config is what ships.
   *
   * Strategy:
   *   - /_next/static/* — leave to Next. Turbopack dev chunks can go
   *     stale if we force immutable caching here; Next already emits
   *     the correct production headers for hashed assets, and because
   *     those filenames carry a content hash they are safe to cache
   *     hard. That — not caching the HTML — is what makes a deploy
   *     fast.
   *   - /api/*          — no-store. API responses are per-user and
   *     must never be shared across requests at the edge.
   *   - Everything else — `private, no-store`. A document or flight
   *     payload is never stored by a shared cache, which fixes the
   *     year-old-HTML problem this rule was written for far more
   *     directly than a short s-maxage did: there is no stale HTML to
   *     serve, so there are no missing chunk hashes to 404 on.
   *     `Vary` goes out too, for any cache that does honour it.
   *
   * Security headers are appended via a separate catch-all rule
   * below — Next.js merges headers from every matching rule, so
   * they apply to every response regardless of which cache rule
   * matched.
   */
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/:path((?!_next/static|_next/image|api).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "private, no-store, max-age=0, must-revalidate",
          },
          {
            // Defence in depth: `no-store` already forbids storing
            // the response, but a cache that ignores it should at
            // least not confuse a flight payload for a document.
            key: "Vary",
            value: "RSC, Next-Router-Prefetch, Next-Router-State-Tree, Next-Url",
          },
        ],
      },
      {
        // Security headers on every response, including /_next/static
        // assets (nosniff matters there) and /api/* (HSTS + referrer-
        // policy don't hurt).
        source: "/:path*",
        headers: [...SECURITY_HEADERS, FRAME_ANCESTORS],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
