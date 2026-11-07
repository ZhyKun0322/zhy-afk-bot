'use strict';
// Connection diagnostic: run `node diagnose.js` and send the output if the bot won't join.
const dns = require('dns').promises;
const mc = require('minecraft-protocol');
const settings = require('./settings.json');
const host = process.argv[2] || settings.server.ip;
const port = Number(process.argv[3] || settings.server.port || 25565);

(async () => {
  console.log(`Target: ${host}:${port}`);
  try { console.log('SRV record:', JSON.stringify(await dns.resolveSrv('_minecraft._tcp.' + host))); }
  catch (e) { console.log('SRV record: none (' + e.code + ')'); }
  try { console.log('Addresses:', JSON.stringify(await dns.lookup(host, { all: true }))); }
  catch (e) { console.log('DNS lookup FAILED:', e.code); }
  try {
    const r = await mc.ping({ host, port, closeTimeout: 8000 });
    const motd = typeof r.description === 'string' ? r.description : JSON.stringify(r.description);
    console.log('Ping OK');
    console.log('  version :', r.version && r.version.name, '(protocol', r.version && r.version.protocol + ')');
    console.log('  players :', r.players && r.players.online + '/' + r.players.max);
    console.log('  motd    :', motd.slice(0, 200));
    console.log('Supported by this bot? ', mc.supportedVersions.includes(String(r.version.name).replace(/^\D*/, '').split(' ')[0]) ? 'yes' : 'CHECK - set "version" in settings.json to the closest supported one');
  } catch (e) {
    console.log('Ping FAILED:', e.code || e.name, e.message || '', Array.isArray(e.errors) ? e.errors.map((x) => x.code + ' ' + x.address + ':' + x.port).join(', ') : '');
  }
  console.log('Bot-supported versions:', mc.supportedVersions.slice(-6).join(', '), '...');
  process.exit(0);
})();
