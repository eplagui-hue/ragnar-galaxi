// =====================================================================
//  Esclat d'Aura — servidor multijugador
//  Serveix el joc (index.html) i connecta els jugadors per sales amb codi.
//  Inici:  npm install   i després   node server.js
// =====================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const MAX_MSG = 64 * 1024;          // mida màxima d'un missatge
const MAX_ROOMS = 500;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------- servidor web: només entrega el joc ----------
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  let file = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  if (file.includes('..') || file === 'server.js' || file === 'package.json' || file.startsWith('node_modules')) { res.writeHead(404); res.end('No trobat'); return; }
  let full = path.join(DIR, file);
  if (!fs.existsSync(full) && fs.existsSync(path.join(DIR, 'public', file))) full = path.join(DIR, 'public', file);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('No trobat'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---------- sales ----------
const rooms = new Map();            // codi -> { host, guest, created }
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (let i = 0; i < 200; i++) {
    let c = ''; for (let j = 0; j < 4; j++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function openRooms() {
  const list = [];
  for (const [code, r] of rooms) if (r.host && !r.guest) list.push({ code, host: r.host.name });
  return list.slice(0, 20);
}
function broadcastRooms() { const list = openRooms(); for (const c of wss.clients) if (!c.room) send(c, { t: 'rooms', list }); }
function leave(ws) {
  const code = ws.room; if (!code) return;
  const r = rooms.get(code); ws.room = null;
  if (!r) return;
  const other = r.host === ws ? r.guest : r.host;
  if (r.host === ws) {
    // si marxa l'amfitrió, la sala es tanca
    rooms.delete(code);
    if (other) { other.room = null; send(other, { t: 'peer_left' }); }
  } else {
    r.guest = null;
    if (other) send(other, { t: 'peer_left' });
  }
  broadcastRooms();
}

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });
wss.on('connection', ws => {
  ws.alive = true; ws.room = null; ws.name = 'Jugador';
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'ping': send(ws, { t: 'pong', ts: m.ts }); break;
      case 'list': send(ws, { t: 'rooms', list: openRooms() }); break;
      case 'create': {
        leave(ws);
        if (rooms.size >= MAX_ROOMS) { send(ws, { t: 'err', m: 'El servidor és ple. Prova-ho d\'aquí a una estona.' }); break; }
        const code = newCode(); if (!code) { send(ws, { t: 'err', m: 'No s\'ha pogut crear la sala.' }); break; }
        ws.name = String(m.name || 'Jugador').slice(0, 16);
        rooms.set(code, { host: ws, guest: null, created: Date.now() });
        ws.room = code;
        send(ws, { t: 'created', code });
        broadcastRooms();
        break;
      }
      case 'join': {
        const code = String(m.code || '').toUpperCase().slice(0, 4);
        const r = rooms.get(code);
        if (!r) { send(ws, { t: 'err', m: 'No existeix cap sala amb aquest codi.' }); break; }
        if (r.guest) { send(ws, { t: 'err', m: 'La sala ja és plena.' }); break; }
        if (r.host === ws) break;
        leave(ws);
        ws.name = String(m.name || 'Jugador').slice(0, 16);
        r.guest = ws; ws.room = code;
        send(ws, { t: 'joined', code, host: r.host.name });
        send(r.host, { t: 'peer', name: ws.name });
        broadcastRooms();
        break;
      }
      case 'leave': leave(ws); send(ws, { t: 'rooms', list: openRooms() }); break;
      case 'r': {
        // reenviar el missatge a l'altre jugador de la sala
        const r = rooms.get(ws.room); if (!r) break;
        const other = r.host === ws ? r.guest : r.host;
        if (other && other.readyState === 1) other.send(JSON.stringify({ t: 'r', d: m.d }));
        break;
      }
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// comprova cada 20 s que les connexions segueixen vives
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; try { ws.ping(); } catch (e) { }
  }
  // sales abandonades de fa més de 6 hores
  const now = Date.now();
  for (const [code, r] of rooms) if (now - r.created > 6 * 3600 * 1000 && !r.guest) { rooms.delete(code); }
}, 20000);

server.listen(PORT, () => console.log(`Esclat d'Aura escoltant al port ${PORT}`));
