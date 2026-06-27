/**
 * Garage Manager – serwer Node.js
 *
 * Dwa tryby przechowywania danych:
 *  1) Plik lokalny (data.json) – domyślny, do użycia na NAS / komputerze.
 *  2) PostgreSQL – używany automatycznie, gdy ustawiona jest zmienna
 *     środowiskowa DATABASE_URL (tak działa np. na Render.com, gdzie
 *     darmowy plan webowy NIE ma trwałego dysku, ale baza Postgres jest
 *     darmowa i trwała).
 *
 * Wymagania: node >= 18
 * Instalacja:  npm install
 * Uruchomienie: node server.js
 *
 * Hasło: ustaw zmienną środowiskową GARAZ_PASSWORD przed uruchomieniem:
 *   GARAZ_PASSWORD=mojeTajneHaslo node server.js
 */

const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const PORT     = process.env.PORT          || 3000;
const PASSWORD = process.env.GARAZ_PASSWORD || 'garaz123'; // ← zmień na swoje hasło
const DATA_DIR    = process.env.DATA_DIR || __dirname;
const DATA_FILE   = path.join(DATA_DIR, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const USE_DB      = !!process.env.DATABASE_URL;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ════════════════════════════════════════════════════════════════════════════
// WARSTWA DANYCH — jeden interfejs, dwa backendy (plik / Postgres)
// ════════════════════════════════════════════════════════════════════════════

let db = { items: [], nextId: 1 }; // trzymane w pamięci, zsynchronizowane z trwałym storage
let pgPool = null;

async function initStorage() {
  if (USE_DB) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Render wymaga SSL
    });
    // Jedna tabela, jeden wiersz z całym blobem JSON — najprostszy, najbardziej
    // odporny na zmiany schematu sposób przechowywania (lista przedmiotów
    // zmienia pola dość często w trakcie rozwoju aplikacji).
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS garage_data (
        id INTEGER PRIMARY KEY DEFAULT 1,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    const { rows } = await pgPool.query('SELECT payload FROM garage_data WHERE id = 1');
    if (rows.length) {
      db = rows[0].payload;
    } else {
      await pgPool.query('INSERT INTO garage_data (id, payload) VALUES (1, $1)', [JSON.stringify(db)]);
    }
    console.log('🐘  Dane przechowywane w PostgreSQL (trwałe na Render).');
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    }
    console.log(`📁  Dane przechowywane w pliku: ${DATA_FILE}`);
  }
}

async function persist() {
  if (USE_DB) {
    await pgPool.query(
      'UPDATE garage_data SET payload = $1, updated_at = now() WHERE id = 1',
      [JSON.stringify(db)]
    );
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  }
}

// ── Sesje (prosta mapa token → timestamp, w pamięci procesu) ──────────────────
const sessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 dni

function createToken() { return crypto.randomBytes(32).toString('hex'); }
function isValidToken(token) {
  if (!token || !sessions.has(token)) return false;
  const s = sessions.get(token);
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(token); return false; }
  return true;
}

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (isValidToken(token)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Logowanie ─────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    const token = createToken();
    sessions.set(token, { createdAt: Date.now() });
    console.log(`✅  Nowe logowanie (aktywne sesje: ${sessions.size})`);
    return res.json({ token });
  }
  console.log('⛔  Błędne hasło');
  res.status(403).json({ error: 'Złe hasło' });
});

// ── API (chronione) ──────────────────────────────────────────────────────────

app.get('/api/items', requireAuth, (req, res) => {
  res.json(db.items);
});

// Konfiguracja kontenerów (regałów, szafek, biurek…)
app.get('/api/labels', requireAuth, (req, res) => {
  res.json({
    containers: db.containers || null,
    nextContainerId: db.nextContainerId || null,
  });
});
app.put('/api/labels', requireAuth, async (req, res) => {
  if (req.body.containers) db.containers = req.body.containers;
  if (req.body.nextContainerId) db.nextContainerId = req.body.nextContainerId;
  try {
    await persist();
    broadcast({ type: 'LABELS_UPDATED', containers: db.containers, nextContainerId: db.nextContainerId });
    res.json({ containers: db.containers, nextContainerId: db.nextContainerId });
  } catch(e) {
    res.status(500).json({ error: 'Błąd zapisu' });
  }
});

app.post('/api/items', requireAuth, async (req, res) => {
  const item = {
    id: db.nextId++,
    name:     req.body.name     || 'Bez nazwy',
    cat:      req.body.cat      || 'Inne',
    regal:    req.body.regal    || 'R1',
    polka:    req.body.polka    || 'P1',
    storage:  req.body.storage  || 'loose',
    customColor: req.body.customColor || null,
    note:     req.body.note     || '',
    photo:    req.body.photo    || null,
    subitems: req.body.subitems || [],
    posIndex: req.body.posIndex || null,
    posTotal: req.body.posTotal || null,
    stackLevel: req.body.stackLevel || null,
    stackTotal: req.body.stackTotal || null,
    qty: req.body.qty ?? null,
    qtyUnit: req.body.qtyUnit || null,
    qtyThreshold: req.body.qtyThreshold ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.items.push(item);
  try {
    await persist();
    broadcast({ type: 'ITEM_ADDED', item });
    res.status(201).json(item);
  } catch (e) {
    console.error('Błąd zapisu:', e);
    res.status(500).json({ error: 'Błąd zapisu danych' });
  }
});

app.put('/api/items/:id', requireAuth, async (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = db.items.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.items[idx] = { ...db.items[idx], ...req.body, id, updatedAt: new Date().toISOString() };
  try {
    await persist();
    broadcast({ type: 'ITEM_UPDATED', item: db.items[idx] });
    res.json(db.items[idx]);
  } catch (e) {
    console.error('Błąd zapisu:', e);
    res.status(500).json({ error: 'Błąd zapisu danych' });
  }
});

app.delete('/api/items/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  db.items = db.items.filter(x => x.id !== id);
  try {
    await persist();
    broadcast({ type: 'ITEM_DELETED', id });
    res.sendStatus(204);
  } catch (e) {
    console.error('Błąd zapisu:', e);
    res.status(500).json({ error: 'Błąd zapisu danych' });
  }
});

app.get('/api/export/csv', requireAuth, (req, res) => {
  const header = 'ID,Nazwa,Kategoria,Regał,Półka,Pozycja,Miejsc,Poziom,Poziomów,Ilość,Jednostka,Próg,Przechowywanie,Notatka,Podpozycje,Zaktualizowano\n';
  const rows = db.items.map(i => {
    const sub = (i.subitems||[]).map(s => `${s.name}${s.qty!=null?' x'+s.qty:''}${s.unit?' '+s.unit:''}`).join(' | ');
    return [
      i.id,
      `"${(i.name||'').replace(/"/g,'""')}"`,
      `"${(i.cat||'').replace(/"/g,'""')}"`,
      i.regal, i.polka,
      i.posIndex||'', i.posTotal||'',
      i.stackLevel||'', i.stackTotal||'',
      i.qty??'', i.qtyUnit||'', i.qtyThreshold??'',
      `"${(i.storage||'').replace(/"/g,'""')}"`,
      `"${(i.note||'').replace(/"/g,'""')}"`,
      `"${sub.replace(/"/g,'""')}"`,
      i.updatedAt,
    ].join(',');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="garaz.csv"');
  res.send('\uFEFF' + header + rows.join('\n'));
});

// Healthcheck — przydatny dla Render i innych platform PaaS
app.get('/healthz', (req, res) => res.send('ok'));

// Pliki statyczne (index.html) – bez autoryzacji
app.use(express.static(__dirname));

// ── HTTP + WebSocket ──────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');
  if (!isValidToken(token)) {
    ws.send(JSON.stringify({ type: 'AUTH_ERROR' }));
    ws.close();
    return;
  }
  ws.send(JSON.stringify({ type: 'INIT', items: db.items }));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initStorage().then(() => {
  server.listen(PORT, () => {
    console.log(`✅  Garage Manager działa na http://localhost:${PORT}`);
    console.log(`🔑  Hasło: ${PASSWORD}`);
    console.log(`💾  Backend danych: ${USE_DB ? 'PostgreSQL' : 'plik lokalny'}`);
  });
}).catch(err => {
  console.error('❌  Nie udało się zainicjować storage:', err);
  process.exit(1);
});
