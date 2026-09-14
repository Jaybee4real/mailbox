import type { MetadataRoute } from 'next'

/**
 * A private mailbox: no crawler is welcome, and the AI agents are named
 * individually because several of them honour a specific disallow while
 * ignoring the wildcard.
 */
const AGENTS = [
  '*',
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
  'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'Googlebot', 'Bingbot', 'Applebot', 'Applebot-Extended',
  'CCBot', 'Amazonbot', 'meta-externalagent', 'FacebookBot',
  'DuckAssistBot', 'cohere-ai', 'YouBot', 'Bytespider', 'Diffbot', 'ImagesiftBot',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: AGENTS.map(userAgent => ({ userAgent, disallow: '/' })),
  }
}
