import type { MetadataRoute } from 'next'
import { CLIENT_BRAND } from '@/lib/brand.client'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${CLIENT_BRAND.name} Mail`,
    short_name: CLIENT_BRAND.name,
    description: `The ${CLIENT_BRAND.name} team mailbox`,
    start_url: '/mail',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: CLIENT_BRAND.accent,
    orientation: 'portrait-primary',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
