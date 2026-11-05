import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  plugins: [
    VitePWA({
      disable: mode === 'android',
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['app-icons/*.png', 'favicon.png', 'favicon.svg', 'favicon.ico', 'favicon-16.png', 'favicon-48.png', 'logo.svg'],
      manifest: {
        name: 'Fareloch — Macro & Calorie Log',
        short_name: 'Fareloch',
        description: 'Private food, macro, recipe, and weight tracking',
        theme_color: '#10B981',
        background_color: '#F9FAFB',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/app-icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/app-icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 300 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3457',
    },
  },
}));
