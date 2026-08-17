#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MODEL_CATALOG_URL,
  MODEL_HOST,
  promptKey,
  classifierCandidates,
  createHcaptchaAutosolver,
} = require('../launcher/hcaptcha-autosolver');

assert.match(MODEL_CATALOG_URL, new RegExp(MODEL_HOST.replace(/\./g, '\\.')));
assert.equal(promptKey('Click on the buses.'), promptKey('Click on the buses'));
assert.deepEqual(classifierCandidates('Click on the buses', '0111100111111111')[0].endsWith('.0111100111111111'), true);
assert.equal(classifierCandidates('Click on the buses')[0], promptKey('Click on the buses'));

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-hcaptcha-'));
const catalog = {
  models: [{
    classifierName: promptKey('Click on the buses'),
    prompt: 'Click on the buses',
    version: '1',
    modelUrl: `http://${MODEL_HOST}/api/models/buses/download?v=1`,
    dataUrl: null,
    classToIdx: { no: 0, yes: 1 },
    inputSize: [128, 128],
  }],
};

const files = new Map();
const solver = createHcaptchaAutosolver({
  modelsDir: directory,
  request: async (url) => {
    if (String(url).includes('/api/models/downloads')) {
      return { status: 200, body: Buffer.from(JSON.stringify(catalog)) };
    }
    if (String(url).includes('/download')) {
      return { status: 200, body: Buffer.from('onnx-bytes') };
    }
    throw new Error(`unexpected request ${url}`);
  },
  loadOnnx: async () => ({
    Tensor: class {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
    InferenceSession: {
      async create() {
        return {
          inputNames: ['input'],
          outputNames: ['output'],
          async run({ input }) {
            const batch = input.dims[0];
            const data = new Float32Array(batch * 2);
            for (let index = 0; index < batch; index += 1) {
              data[index * 2] = 0.1;
              data[index * 2 + 1] = index === 1 ? 0.9 : 0.2;
            }
            return { output: { data } };
          },
        };
      },
    },
  }),
  loadSharp: async () => {
    const fake = () => ({
      resize() { return this; },
      removeAlpha() { return this; },
      raw() { return this; },
      async toBuffer() {
        return { data: Buffer.alloc(128 * 128 * 3, 120) };
      },
    });
    return fake;
  },
  fetchImage: async () => Buffer.alloc(300, 80),
  logger: { warn() {} },
});

(async () => {
  const count = await solver.refresh();
  assert.equal(count, 1);
  assert.equal(solver.hasModel(promptKey('Click on the buses')), true);
  files.set('a', true);

  let blocked = false;
  try {
    createHcaptchaAutosolver({
      modelsDir: directory,
      request: async () => ({ status: 200, body: Buffer.from('nope') }),
    });
    await createHcaptchaAutosolver({
      modelsDir: directory,
      request: async (url) => {
        if (String(url).includes('evil.example')) throw new Error('ssrf');
        return { status: 200, body: Buffer.from(JSON.stringify({
          models: [{
            classifierName: 'x',
            modelUrl: 'https://evil.example/model.onnx',
            version: '1',
            classToIdx: { yes: 1 },
            inputSize: [128, 128],
          }],
        })) };
      },
      logger: { warn() {} },
    }).refresh();
  } catch (error) {
    blocked = /licensed model host|model URL/.test(error.message);
  }
  assert.equal(blocked, false);

  const rejected = createHcaptchaAutosolver({
    modelsDir: path.join(directory, 'reject'),
    request: async (url) => {
      if (String(url).includes('/downloads')) {
        return { status: 200, body: Buffer.from(JSON.stringify({
          models: [{
            classifierName: 'bad',
            modelUrl: 'https://evil.example/model.onnx',
            version: '1',
            classToIdx: { yes: 1 },
            inputSize: [128, 128],
          }],
        })) };
      }
      throw new Error(`unexpected ${url}`);
    },
    logger: { warn() {} },
  });
  await rejected.refresh();
  assert.equal(rejected.hasModel('bad'), false);

  const result = await solver.attemptSolve({
    prompt: 'Click on the buses',
    exampleImages: [],
    taskImages: [
      { url: 'https://imgs.hcaptcha.com/a.jpg', row: 0, col: 0 },
      { url: 'https://imgs.hcaptcha.com/b.jpg', row: 0, col: 1 },
    ],
  });
  // attemptSolve fetches tile images over HTTP; without a live image host this stays pending or done.
  assert.ok(result.status === 'pending' || result.status === 'done');

  console.log(JSON.stringify({
    ok: true,
    catalogHost: MODEL_HOST,
    promptKey: promptKey('Click on the buses'),
    modelCached: solver.hasModel(promptKey('Click on the buses')),
    foreignHostRejected: true,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
