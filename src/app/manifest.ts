import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FreeTV',
    short_name: 'FreeTV',
    description: 'FreeTV 影视聚合搜索与播放',
    start_url: '/',
    display: 'standalone',
    background_color: '#111111',
    theme_color: '#0b101a',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
