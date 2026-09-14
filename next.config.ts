import type { NextConfig } from "next";

/**
 * This is a private mailbox. Nothing here should ever be indexed, summarised or
 * used as training data, so the refusal is sent as a header too — a crawler that
 * ignores robots.txt still receives it on every response.
 */
const noIndexHeaders = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  // Ensure the contact-form email templates ship with the serverless bundle.
  // Without this, `readFileSync('lib/emails/templates/*.html')` works in dev
  // but the .html files get tree-shaken out of the production trace.
  outputFileTracingIncludes: {
    '/api/contact': ['./lib/emails/templates/**/*.html'],
  },
  poweredByHeader: false,
  env: {
    // Captured at build time. On Vercel this is the last successful build's
    // ISO timestamp; locally it's the time `next build` ran.
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  async headers() {
    return [
      { source: '/:path*', headers: noIndexHeaders },
      // The viewer shows a PDF in an iframe pointed at our own route, and DENY refuses
      // that as firmly as it refuses a stranger — the browser reports it as the site
      // refusing to connect, which reads as the file being unreachable. These paths only
      // ever return an attachment, and only to a signed-in caller, so they allow being
      // framed by this origin and nothing else.
      {
        source: '/api/mail/inbox/attachments/download',
        headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
      },
      {
        source: '/api/mail/emails/:id/attachments/download',
        headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
      },
    ];
  },
};

export default nextConfig;
