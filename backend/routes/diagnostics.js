import { Router } from 'express';
import { asyncHandler, requireSession } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';

export const diagnosticsRouter = Router();
diagnosticsRouter.use(requireSession);

diagnosticsRouter.post('/diagnostics/ping', asyncHandler(async (req, res) => {
  const host = req.body.host;
  if (!host || typeof host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('-')) {
    throw new AppError('INVALID_INPUT', 'A valid hostname or IP address is required.', { status: 400 });
  }
  
  // Use /bin/ping -c 4 host
  const result = await req.ubus.tryCall('file', 'exec', {
    command: '/bin/ping',
    params: ['-c', '4', '-W', '2', host]
  }, null);

  if (!result) {
    throw new AppError('PING_FAILED', 'Ping command failed or is not allowed.', { status: 500 });
  }

  res.json({ output: result.stdout || result.stderr || 'No output.', code: result.code });
}));

diagnosticsRouter.post('/diagnostics/traceroute', asyncHandler(async (req, res) => {
  const host = req.body.host;
  if (!host || typeof host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('-')) {
    throw new AppError('INVALID_INPUT', 'A valid hostname or IP address is required.', { status: 400 });
  }
  
  let result = await req.ubus.tryCall('file', 'exec', {
    command: '/usr/bin/traceroute',
    params: ['-m', '15', '-w', '2', '-q', '1', host]
  }, null);

  if (!result || result.code === 127) {
    result = await req.ubus.tryCall('file', 'exec', {
      command: '/bin/traceroute',
      params: ['-m', '15', '-w', '2', '-q', '1', host]
    }, null);
  }

  if (!result) {
    throw new AppError('TRACEROUTE_FAILED', 'Traceroute command failed or is not allowed.', { status: 500 });
  }

  res.json({ output: result.stdout || result.stderr || 'No output.', code: result.code });
}));
