import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { errorHandler, requireAppHeader } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { bandwidthRouter } from './routes/bandwidth.js';
import { dhcpRouter } from './routes/dhcp.js';
import { diagnosticsRouter } from './routes/diagnostics.js';
import { modeRouter } from './routes/mode.js';
import { statusRouter } from './routes/status.js';
import { systemRouter } from './routes/system.js';
import { wifiRouter } from './routes/wifi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.join(here, '..', 'frontend');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
// Restores carry a whole config snapshot, so they need more room than a settings form.
app.use('/api/system/restore', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '64kb' }));

app.use('/api', requireAppHeader);
app.use('/api/auth', authRouter);
app.use('/api', statusRouter);
app.use('/api', modeRouter);
app.use('/api', wifiRouter);
app.use('/api', dhcpRouter);
app.use('/api', diagnosticsRouter);
app.use('/api', bandwidthRouter);
app.use('/api', systemRouter);

app.use(express.static(frontendDir, { extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.use(errorHandler);

app.listen(config.port, config.bindHost, () => {
  console.log(`EasyMode running at http://${config.bindHost}:${config.port}`);
  console.log(`Default router address: ${config.defaultRouterHost}`);
});
