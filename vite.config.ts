import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

interface SoundFontListEntry {
  id: string;
  name: string;
  label: string;
  url: string;
  sizeBytes: number;
}

function scanSoundFontsDir(dirPath: string): SoundFontListEntry[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, {withFileTypes: true});
  const list: SoundFontListEntry[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.toLowerCase().endsWith('.sf2')) continue;
    const full = path.join(dirPath, ent.name);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(full).size;
    } catch {
      sizeBytes = 0;
    }
    const label = ent.name.replace(/\.sf2$/i, '').replace(/[_-]+/g, ' ').trim();
    list.push({
      id: `library:${ent.name}`,
      name: ent.name,
      label: label || ent.name,
      url: `/soundfonts/${encodeURIComponent(ent.name)}`,
      sizeBytes,
    });
  }
  list.sort((a, b) => a.label.localeCompare(b.label, 'de', {sensitivity: 'base'}));
  return list;
}

export default defineConfig(() => {
  const soundfontsDir = path.resolve(__dirname, 'public/soundfonts');

  return {
    plugins: [
      react(),
      tailwindcss(),
      // Live endpoint & build manifest for local .sf2 files placed in public/soundfonts/
      {
        name: 'local-soundfonts-manifest',
        configureServer(server) {
          server.middlewares.use('/api/soundfonts', (_req, res) => {
            const files = scanSoundFontsDir(soundfontsDir);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({files}));
          });
        },
        configurePreviewServer(server) {
          server.middlewares.use('/api/soundfonts', (_req, res) => {
            const files = scanSoundFontsDir(soundfontsDir);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({files}));
          });
        },
        closeBundle(error?: Error): void {
          if (error) return;
          const distSoundfonts = path.resolve(__dirname, 'dist/soundfonts');
          if (!fs.existsSync(distSoundfonts)) {
            fs.mkdirSync(distSoundfonts, {recursive: true});
          }
          const files = scanSoundFontsDir(soundfontsDir);
          fs.writeFileSync(
            path.join(distSoundfonts, 'manifest.json'),
            JSON.stringify({files}, null, 2),
            'utf-8'
          );
        },
      },
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
