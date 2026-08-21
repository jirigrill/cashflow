import { defineConfig, type Plugin } from 'vite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DATA_DIR = resolve(__dirname, '../data');

// The CSVs live outside the prototype (and are gitignored), so serve them
// through middleware rather than copying them into public/.
function serveData(): Plugin {
  return {
    name: 'serve-data',
    configureServer(server) {
      server.middlewares.use('/data', async (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
        try {
          if (url === '/' || url === '/index.json') {
            const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.csv')).sort();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(files));
            return;
          }
          if (url.includes('..')) return next();
          const body = await readFile(resolve(DATA_DIR, url.replace(/^\//, '')), 'utf8');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [serveData()],
  server: { port: 5173, open: false },
});
