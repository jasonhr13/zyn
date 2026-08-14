'use strict';

const http = require('http');
const path = require('path');
const WebSocket = require(path.join(
  __dirname,
  '..',
  'launcher',
  'node_modules',
  'ws',
));

const port = Number(process.argv[2]);
if (!port) {
  console.error('Usage: node scripts/profile-crud-smoke-test.js <debug-port>');
  process.exit(2);
}

http.get(`http://127.0.0.1:${port}/json`, (response) => {
  let body = '';
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => {
    const target = JSON.parse(body).find((entry) => entry.type === 'page');
    if (!target) throw new Error('Zyn renderer target was not found');
    const socket = new WebSocket(target.webSocketDebuggerUrl);

    socket.on('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          awaitPromise: true,
          returnByValue: true,
          expression: `(() => {
            const ipc = window.require('electron').ipcRenderer;
            const before = ipc.sendSync('getProfiles') || [];
            const created = ipc.sendSync('createProfile', {
              profileName: 'React 18 CRUD smoke test',
              email: 'react18-smoke@example.invalid',
              shipping: {
                firstName: 'React', lastName: 'Test', address: '1 Test Way',
                address2: '', city: 'Testville', state: 'CA', zipcode: '90000', country: 'US'
              },
              payment: {
                cardName: 'React Test', cardNumber: '4111111111111111',
                cardMonth: '12', cardYear: '2099', cardCvv: '123'
              }
            });
            const afterCreate = ipc.sendSync('getProfiles') || [];
            ipc.sendSync('updateProfile', {
              id: created.id,
              data: { profileName: 'React 18 CRUD updated' }
            });
            const afterUpdate = ipc.sendSync('getProfiles') || [];
            const updated = afterUpdate.find(profile => profile.id === created.id);
            ipc.sendSync('deleteProfile', created.id);
            const afterDelete = ipc.sendSync('getProfiles') || [];
            return {
              created: afterCreate.length === before.length + 1,
              updated: Boolean(updated && updated.profileName === 'React 18 CRUD updated'),
              deleted: afterDelete.length === before.length,
              restoredCount: afterDelete.length
            };
          })()`,
        },
      }));
    });

    socket.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      if (message.result.exceptionDetails) {
        console.error(message.result.exceptionDetails.text || 'CRUD evaluation failed');
        process.exitCode = 1;
      } else {
        const result = message.result.result.value;
        console.log(JSON.stringify(result, null, 2));
        if (!result.created || !result.updated || !result.deleted) process.exitCode = 1;
      }
      socket.close();
    });
  });
}).on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
