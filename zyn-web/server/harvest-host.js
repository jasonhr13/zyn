'use strict';

const { createMobileHarvesterBridge } = require('../../launcher/mobile-harvester-bridge');

function createHarvestHost({
  dataDirectory,
  authority,
  bank,
  store,
  logger = console,
} = {}) {
  const bridge = createMobileHarvesterBridge({
    dataDirectory,
    authority,
    enabled: () => false,
    hostRemote: () => {
      const status = authority.cached ? authority.cached() : {};
      return status.ok === true && status.sessionKind !== 'harvester';
    },
    ensureBroker: () => {},
    getCookieBank: async () => {
      const snapshot = bank.snapshot();
      return {
        ok: true,
        login: snapshot.login,
        atc: snapshot.atc,
        pools: { login: snapshot.login, atc: snapshot.atc },
        activity: { waiting: snapshot.waiting || { login: 0, atc: 0 } },
        demand: snapshot.demand,
        targets: snapshot.demand && snapshot.demand.targets,
      };
    },
    saveCookie: cookie => {
      const saved = bank.saveCookie(cookie.type, cookie.headers, cookie.proxy, cookie) ? 1 : 0;
      if (saved) {
        logger.log(`[harvest] saved ${cookie.type} cookie from ${cookie.harvesterId || cookie.source || 'remote'}`);
      } else {
        logger.log(`[harvest] rejected ${cookie.type || 'unknown'} cookie (empty or invalid headers)`);
      }
      return { ok: saved > 0, saved };
    },
    getProxyCatalog: () => store.getProxies(),
    cookieTtlMs: () => Math.max(30, Number(store.getSettings().targetCookieTtlSec) || 600) * 1000,
    logger,
  });
  return bridge;
}

module.exports = { createHarvestHost };
