import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    root: path.resolve(__dirname, 'src/frontend'),
    base: './',
    build: {
        outDir: path.resolve(__dirname, 'public'),
        emptyOutDir: true,
        rollupOptions: {
            input: path.resolve(__dirname, 'src/frontend/index.html'),
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/data': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src/frontend'),
        },
    },
});
