'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const MODEL_CATALOG_URL = 'http://104.171.171.30:3456/api/models/downloads';
const MODEL_HOST = '104.171.171.30';
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const DEFAULT_INPUT = [128, 128];
const CONFIG_INTERVAL_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function promptKey(prompt) {
  return Buffer.from(String(prompt || '').trim().replace(/\.$/, ''), 'utf8').toString('base64url');
}

async function exampleHash(buffer, sharp) {
  if (!buffer || !buffer.length || !sharp) return '';
  let image = sharp(buffer);
  const meta = await image.metadata();
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  let source = buffer;
  if (width && height && width !== height) {
    const band = Math.floor(height / 4);
    source = await image.extract({ left: 0, top: band * 2, width, height: band }).jpeg().toBuffer();
    image = sharp(source);
  }
  const { data } = await image.resize(8, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  for (const value of data) total += value;
  const average = total / data.length;
  let bits = '';
  for (const value of data) bits += value > average ? '1' : '0';
  return bits.slice(0, 16);
}

function classifierCandidates(prompt, hash) {
  const key = promptKey(prompt);
  if (!key) return [];
  const hashed = hash ? `${key}.${hash}` : '';
  return hashed ? [hashed, key] : [key];
}

function assertModelUrl(value) {
  const target = new URL(String(value || ''));
  if (target.protocol !== 'http:' || target.hostname !== MODEL_HOST) {
    throw new Error('model URL is not the licensed model host');
  }
  return target;
}

function defaultRequest(url) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); }
    catch {
      reject(new Error('model URL is invalid'));
      return;
    }
    if (target.hostname !== MODEL_HOST || target.protocol !== 'http:') {
      reject(new Error('model URL is not the licensed model host'));
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(target, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        defaultRequest(new URL(response.headers.location, target).href).then(resolve, reject);
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        const part = Buffer.from(chunk);
        chunks.push(part);
        bytes += part.length;
        if (bytes > MAX_DOWNLOAD_BYTES) {
          response.destroy(new Error('model download was unexpectedly large'));
        }
      });
      response.on('error', reject);
      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('model request timed out')));
  });
}

function requireNative(name) {
  const roots = [
    process.resourcesPath && path.join(process.resourcesPath, 'app', 'node_modules', name),
    path.join(__dirname, 'node_modules', name),
    name,
  ].filter(Boolean);
  let last;
  for (const id of roots) {
    try { return require(id); }
    catch (error) { last = error; }
  }
  throw last || new Error(`Could not load ${name}`);
}

function createHcaptchaAutosolver({
  catalogUrl = MODEL_CATALOG_URL,
  modelsDir = '',
  request = defaultRequest,
  fetchImage: fetchImageOverride = null,
  loadOnnx = () => requireNative('onnxruntime-node'),
  loadSharp = () => requireNative('sharp'),
  logger = console,
} = {}) {
  const state = {
    config: { models: [] },
    models: new Map(),
    sessions: new Map(),
    loading: new Map(),
    onnx: null,
    sharp: null,
    ready: false,
    started: false,
    timer: null,
    dir: modelsDir,
  };

  function directory() {
    if (state.dir) return state.dir;
    try {
      const { app } = require('electron');
      state.dir = path.join(app.getPath('userData'), 'hcaptcha-models');
    } catch {
      state.dir = path.join(process.cwd(), '.zyn-hcaptcha-models');
    }
    return state.dir;
  }

  async function ensureNatives() {
    if (!state.onnx) state.onnx = await loadOnnx();
    if (!state.sharp) state.sharp = await loadSharp();
    state.ready = true;
    return state.ready;
  }

  async function fetchCatalog() {
    const response = await request(catalogUrl);
    if (!response || response.status !== 200) throw new Error('model catalog request failed');
    const parsed = JSON.parse(Buffer.from(response.body || '').toString('utf8'));
    const models = Array.isArray(parsed && parsed.models) ? parsed.models : [];
    return models.map((raw) => {
      const item = asRecord(raw);
      const classifierName = String(item.classifierName || '').trim();
      const input = Array.isArray(item.inputSize) ? item.inputSize : DEFAULT_INPUT;
      const classes = asRecord(item.classToIdx);
      return {
        classifierName,
        prompt: String(item.prompt || '').trim(),
        version: String(item.version == null ? '' : item.version),
        modelUrl: String(item.modelUrl || '').trim(),
        dataUrl: String(item.dataUrl || '').trim(),
        inputSize: [Number(input[0]) || 128, Number(input[1]) || 128],
        yesIdx: Number.isFinite(Number(classes.yes)) ? Number(classes.yes) : 1,
      };
    }).filter(item => item.classifierName && item.modelUrl);
  }

  async function writeFile(file, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }

  async function syncModel(item) {
    assertModelUrl(item.modelUrl);
    const root = path.join(directory(), item.classifierName);
    const versionFile = path.join(root, 'version');
    const modelFile = path.join(root, 'model.onnx');
    const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8') : '';
    if (current === item.version && fs.existsSync(modelFile)) return;
    const model = await request(item.modelUrl);
    if (!model || model.status !== 200 || !model.body?.length) throw new Error(`model download failed: ${item.classifierName}`);
    await writeFile(modelFile, model.body);
    if (item.dataUrl) {
      assertModelUrl(item.dataUrl);
      const extra = await request(item.dataUrl);
      if (!extra || extra.status !== 200 || !extra.body?.length) throw new Error(`model data download failed: ${item.classifierName}`);
      await writeFile(path.join(root, 'model.onnx.data'), extra.body);
    }
    fs.writeFileSync(versionFile, item.version);
    state.sessions.delete(item.classifierName);
  }

  async function refresh() {
    const models = await fetchCatalog();
    state.config = { models };
    state.models = new Map(models.map(item => [item.classifierName, item]));
    fs.mkdirSync(directory(), { recursive: true });
    await Promise.all(models.map(item => syncModel(item).catch((error) => {
      logger.warn?.(`[hcaptcha] model sync ${item.classifierName}: ${error.message}`);
    })));
    return models.length;
  }

  function start() {
    if (state.started) return state;
    state.started = true;
    refresh().catch((error) => logger.warn?.(`[hcaptcha] catalog: ${error.message}`));
    ensureNatives().catch((error) => logger.warn?.(`[hcaptcha] onnx: ${error.message}`));
    state.timer = setInterval(() => {
      refresh().catch((error) => logger.warn?.(`[hcaptcha] catalog: ${error.message}`));
    }, CONFIG_INTERVAL_MS);
    state.timer.unref?.();
    return state;
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.started = false;
  }

  function hasModel(name) {
    return fs.existsSync(path.join(directory(), name, 'model.onnx'));
  }

  async function getSession(name) {
    if (state.sessions.has(name)) return state.sessions.get(name);
    if (state.loading.has(name)) return state.loading.get(name);
    const work = (async () => {
      await ensureNatives();
      const item = state.models.get(name);
      const file = path.join(directory(), name, 'model.onnx');
      if (!fs.existsSync(file)) return null;
      const session = await state.onnx.InferenceSession.create(file, { executionProviders: ['cpu'] });
      const packed = {
        session,
        inputSize: item?.inputSize || DEFAULT_INPUT,
        yesIdx: item?.yesIdx ?? 1,
      };
      state.sessions.set(name, packed);
      return packed;
    })();
    state.loading.set(name, work);
    try { return await work; }
    finally { state.loading.delete(name); }
  }

  async function preprocess(buffer, width, height) {
    const { data } = await state.sharp(buffer)
      .resize(width, height, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = width * height;
    const tensor = new Float32Array(3 * pixels);
    for (let pixel = 0, source = 0; pixel < pixels; pixel += 1, source += 3) {
      for (let channel = 0; channel < 3; channel += 1) {
        tensor[channel * pixels + pixel] = (data[source + channel] / 255 - IMAGENET_MEAN[channel]) / IMAGENET_STD[channel];
      }
    }
    return tensor;
  }

  async function predictBatch(name, buffers) {
    const packed = await getSession(name);
    if (!packed || !buffers.length) return null;
    const [rows, cols] = packed.inputSize;
    const plane = 3 * rows * cols;
    const planes = await Promise.all(buffers.map(buffer => preprocess(buffer, cols, rows)));
    const batch = new Float32Array(buffers.length * plane);
    planes.forEach((planeData, index) => batch.set(planeData, index * plane));
    const inputName = packed.session.inputNames[0];
    const outputName = packed.session.outputNames[0];
    const output = (await packed.session.run({
      [inputName]: new state.onnx.Tensor('float32', batch, [buffers.length, 3, rows, cols]),
    }))[outputName].data;
    const noIdx = packed.yesIdx === 1 ? 0 : 1;
    return buffers.map((_buffer, index) => output[index * 2 + packed.yesIdx] > output[index * 2 + noIdx]);
  }

  async function resolveName(prompt, exampleBuffer) {
    const hash = exampleBuffer ? await exampleHash(exampleBuffer, state.sharp) : '';
    return classifierCandidates(prompt, hash).find(hasModel) || '';
  }

  async function fetchImage(url) {
    if (fetchImageOverride) return fetchImageOverride(url);
    const target = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('image URL must be HTTP(S)');
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.get(target, {
        headers: { 'user-agent': 'Mozilla/5.0' },
      }, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          fetchImage(new URL(response.headers.location, target).href).then(resolve, reject);
          return;
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('image download timed out')));
    });
  }

  async function attemptSolve(challenge) {
    const prompt = String(challenge && challenge.prompt || '').trim();
    const tasks = Array.isArray(challenge && challenge.taskImages) ? challenge.taskImages : [];
    const exampleUrl = Array.isArray(challenge && challenge.exampleImages) ? challenge.exampleImages[0] : '';
    if (!prompt || !tasks.length) return { status: 'done', solvable: false, coords: [] };
    await ensureNatives();
    let example = null;
    if (exampleUrl) {
      example = await fetchImage(exampleUrl).catch(() => null);
      if (!example || example.length < 200) return { status: 'pending' };
    }
    const name = await resolveName(prompt, example);
    if (!name) return { status: 'pending' };
    const tiles = [];
    for (const tile of tasks) {
      const url = String(tile && tile.url || '').trim();
      if (!url) return { status: 'pending' };
      const body = await fetchImage(url).catch(() => null);
      if (!body || body.length < 200) return { status: 'pending' };
      tiles.push({
        row: Number(tile.row) || 0,
        col: Number(tile.col) || 0,
        buf: body,
      });
    }
    const votes = await predictBatch(name, tiles.map(tile => tile.buf));
    if (!votes || votes.length !== tiles.length) return { status: 'done', solvable: false, coords: [] };
    const coords = tiles.flatMap((tile, index) => (votes[index] ? [[tile.row, tile.col]] : []));
    return { status: 'done', solvable: true, coords, model: name };
  }

  async function solve(challenge, { maxWaitMs = 90_000, retryDelayMs = 200 } = {}) {
    start();
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        if (!state.ready) await ensureNatives();
        const result = await attemptSolve(challenge);
        if (result.status === 'pending') {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          continue;
        }
        return { solvable: Boolean(result.solvable), coords: result.coords || [], model: result.model || '' };
      } catch (error) {
        logger.warn?.(`[hcaptcha] solve: ${error.message}`);
        return { solvable: false, coords: [], model: '' };
      }
    }
    return { solvable: false, coords: [], model: '' };
  }

  return {
    start,
    stop,
    refresh,
    solve,
    attemptSolve,
    hasModel,
    promptKey,
    classifierCandidates,
    modelsDir: directory,
    catalogUrl,
  };
}

const singleton = createHcaptchaAutosolver();

module.exports = {
  MODEL_CATALOG_URL,
  MODEL_HOST,
  promptKey,
  exampleHash,
  classifierCandidates,
  createHcaptchaAutosolver,
  start: (...args) => singleton.start(...args),
  stop: (...args) => singleton.stop(...args),
  solve: (...args) => singleton.solve(...args),
  refresh: (...args) => singleton.refresh(...args),
};
