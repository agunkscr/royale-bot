import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dashboardState from './src/utils/state-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startDashboard(port = 3000) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'dashboard')));
  app.get('/health', (_, res) => res.status(200).send('OK'));
  app.get('/api/state', (_, res) => res.json(dashboardState.getSnapshot()));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'snapshot', data: dashboardState.getSnapshot() }));
    ws.on('close', () => clients.delete(ws));
  });

  setInterval(() => {
    const data = JSON.stringify({ type: 'snapshot', data: dashboardState.getSnapshot() });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }, 1500);

  server.listen(port, () => {
    console.log(`📊 Dashboard berjalan di http://localhost:${port}`);
  });

  return { server, wss };
}