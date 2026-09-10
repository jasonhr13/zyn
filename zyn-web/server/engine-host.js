'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const engineContract = require('../../launcher/native-engine-contract');

const ENGINE_PORT = 8727;

function defaultEnginePath() {
  if (process.env.ZYN_ENGINE_PATH) return process.env.ZYN_ENGINE_PATH;
  const root = path.resolve(__dirname, '../..');
  if (process.platform === 'linux') return path.join(root, 'native-backend/linux-x64/backend');
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return path.join(root, 'native-backend/darwin-arm64/backend');
  }
  if (process.platform === 'darwin') return path.join(root, 'native-backend/darwin-x64/backend');
  return path.join(root, 'native-backend/windows-x64/backend.exe');
}

function systemCertFile() {
  const fromEnv = String(process.env.SSL_CERT_FILE || '').trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/ssl/cert.pem',
    '/etc/pki/tls/certs/ca-bundle.crt',
  ];
  return candidates.find(file => fs.existsSync(file)) || '';
}

function createEngineHost({
  token,
  shapePort = 4727,
  enginePath = defaultEnginePath(),
  logger = console,
} = {}) {
  if (!token) throw new Error('engine host requires ZYN_SHAPE_TOKEN');
  let wss = null;
  let boundPort = 0;
  let engineConn = null;
  let engineProc = null;
  const waiters = [];
  const listeners = [];

  const send = obj => {
    const envelope = engineContract.parseEnvelope(obj);
    if (!engineConn || engineConn.readyState !== 1) return false;
    engineConn.send(JSON.stringify(envelope));
    return true;
  };

  const spawnEngine = () => {
    if (engineProc) return;
    if (!fs.existsSync(enginePath)) {
      throw new Error(`engine binary not found: ${enginePath}`);
    }
    const certFile = systemCertFile();
    if (process.platform === 'linux' && (!certFile || !fs.existsSync(certFile))) {
      logger.warn?.('[engine] missing SSL CA bundle; Target TLS will fail as Proxy Failed')
        || logger.log('[engine] missing SSL CA bundle; Target TLS will fail as Proxy Failed');
    }
    engineProc = spawn(enginePath, ['-port', String(boundPort || ENGINE_PORT), '-key', 'local'], {
      cwd: path.dirname(enginePath),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ZYN_SHAPE_PORT: String(shapePort),
        ZYN_SHAPE_TOKEN: token,
        ZYN_PARENT_WATCH: '1',
        ...(certFile ? { SSL_CERT_FILE: certFile } : {}),
      },
    });
    const relay = (stream, prefix) => {
      stream.on('data', chunk => {
        const text = String(chunk).trim();
        if (!text) return;
        logger.log(`[engine] ${prefix}${text}`);
        for (const listener of listeners) {
          try {
            listener({
              type: 'task-log',
              messages: [{ data: text, taskID: '' }],
            });
          } catch {}
        }
      });
    };
    relay(engineProc.stdout, '');
    relay(engineProc.stderr, 'err ');
    engineProc.on('exit', (code, signal) => {
      logger.log(`[engine] exited code=${code} signal=${signal}`);
      engineProc = null;
      engineConn = null;
      const pending = waiters.splice(0);
      for (const waiter of pending) {
        if (waiter && typeof waiter.reject === 'function') waiter.reject(new Error(`engine exited code=${code}`));
        else if (typeof waiter === 'function') waiter();
      }
    });
  };

  const listen = () => new Promise((resolve, reject) => {
    if (wss && boundPort) {
      resolve(boundPort);
      return;
    }
    wss = new WebSocketServer({ host: '127.0.0.1', port: ENGINE_PORT });
    wss.on('listening', () => {
      boundPort = wss.address().port;
      resolve(boundPort);
    });
    wss.on('error', reject);
    wss.on('connection', (ws, req) => {
      const sent = Buffer.from(String((req.headers && req.headers['x-zyn-token']) || ''), 'utf8');
      const want = Buffer.from(token, 'utf8');
      if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) {
        ws.close();
        return;
      }
      if (engineConn && engineConn.readyState === 1) {
        ws.close();
        return;
      }
      engineConn = ws;
      for (const waiter of waiters.splice(0)) {
        if (waiter && typeof waiter.resolve === 'function') waiter.resolve();
        else if (typeof waiter === 'function') waiter();
      }
      ws.on('message', data => {
        try {
          const envelope = engineContract.parseEnvelope(data);
          for (const listener of listeners) listener(envelope);
        } catch (error) {
          logger.warn?.('[engine] bad envelope', error.message) || logger.log('[engine] bad envelope', error.message);
        }
      });
      ws.on('close', () => {
        if (engineConn === ws) engineConn = null;
      });
    });
  });

  const ready = (timeoutMs = 20000) => new Promise((resolve, reject) => {
    if (engineConn && engineConn.readyState === 1) {
      resolve();
      return;
    }
    const waiter = { resolve, reject };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error('engine did not connect'));
    }, timeoutMs);
    waiter.resolve = () => {
      clearTimeout(timer);
      resolve();
    };
    waiter.reject = error => {
      clearTimeout(timer);
      reject(error);
    };
    waiters.push(waiter);
    try { spawnEngine(); }
    catch (error) {
      waiter.reject(error);
    }
  });

  const stop = async () => {
    try { if (engineProc) engineProc.kill('SIGTERM'); } catch {}
    engineProc = null;
    engineConn = null;
    if (wss) {
      await new Promise(resolve => wss.close(resolve));
      wss = null;
    }
  };

  return {
    send,
    listen,
    ready,
    stop,
    subscribe: listener => listeners.push(listener),
    connected: () => !!(engineConn && engineConn.readyState === 1),
    enginePath,
    os: os.platform(),
  };
}

module.exports = { createEngineHost, defaultEnginePath, ENGINE_PORT, systemCertFile };
