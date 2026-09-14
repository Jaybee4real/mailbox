import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Metro Peril Mail',
    short_name: 'MP Mail',
    description: 'The Metro Peril team mailbox',
    start_url: '/mail',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#a90317',
    orientation: 'portrait-primary',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
