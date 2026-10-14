**/
 * MailMaster Backend – Node.js + Express + SQLite + SMTP Server
 * 
 * Cài đặt:
 *   cd backend
 *   npm install
 *   node server.js
 *
 * Yêu cầu:
 *   - Node.js >= 18
 *   - Port 25 (SMTP) phải được mở trên server/VPS
 *   - MX record trỏ về IP server
 */

require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const bcrypt         = require('bcrypt');
const jwt            = require('jsonwebtoken');
const Database       = require('better-sqlite3');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const path           = require('path');
const fs             = require('fs');

// ─── CONFIG ────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const SMTP_PORT  = process.env.SMTP_PORT  || 25;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'mailmaster.db');

// ─── DATABASE ──────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    email       TEXT,
    role        TEXT DEFAULT 'user',
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS domains (
    id          TEXT PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'active',
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS email_addresses (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    local       TEXT NOT NULL,
    domain      TEXT NOT NULL,
    note        TEXT,
    status      TEXT DEFAULT 'active',
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (domain) REFERENCES domains(name)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    from_addr   TEXT NOT NULL,
    to_addr     TEXT NOT NULL,
    subject     TEXT,
    body_text   TEXT,
    body_html   TEXT,
    raw         TEXT,
    is_read     INTEGER DEFAULT 0,
    received_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_to    ON messages(to_addr);
  CREATE INDEX IF NOT EXISTS idx_messages_read  ON messages(is_read);
  CREATE INDEX IF NOT EXISTS idx_emails_domain  ON email_addresses(domain);
`);

// Seed default admin
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (id, username, password, role) VALUES (?,?,?,?)')
    .run(uid(), 'admin', hash, 'admin');
  console.log('✅ Admin account created: admin / admin123');
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ─── SMTP SERVER ───────────────────────────────────────────────────
const smtpServer = new SMTPServer({
  // Accept all connections (no auth needed for receiving)
  authOptional: true,
  disabledCommands: ['AUTH'],

  onConnect(session, cb) {
    console.log(`📨 SMTP connection from ${session.remoteAddress}`);
    cb();
  },

  onRcptTo(address, session, cb) {
    // Accept mail for any address we manage
    const email = address.address.toLowerCase();
    const emailRecord = db.prepare('SELECT id FROM email_addresses WHERE email = ? AND status = ?').get(email, 'active');
    if (emailRecord) {
      cb(); // Accept
    } else {
      cb(new Error(`550 Unknown recipient: ${email}`));
    }
  },

  onData(stream, session, cb) {
    let rawData = '';
    stream.on('data', chunk => rawData += chunk);
    stream.on('end', async () => {
      try {
        const parsed = await simpleParser(rawData);
        const toAddresses = (parsed.to?.value || []).map(a => a.address.toLowerCase());

        for (const toAddr of toAddresses) {
          const msgId = uid();
          db.prepare(`
            INSERT INTO messages (id, from_addr, to_addr, subject, body_text, body_html, raw, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            msgId,
            parsed.from?.value[0]?.address || session.envelope.mailFrom.address,
            toAddr,
            parsed.subject || '(Không có tiêu đề)',
            parsed.text || '',
            parsed.html || '',
            rawData.slice(0, 50000), // limit raw size
            Date.now()
          );
          console.log(`✅ Message saved: ${toAddr} (ID: ${msgId})`);
        }

        // Auto-delete old messages (retention policy)
        applyRetentionPolicy();
      } catch (err) {
        console.error('Error parsing email:', err);
      }
      cb();
    });
  },

  onError(err) {
    console.error('SMTP server error:', err);
  }
});

function applyRetentionPolicy() {
  const retentionDays = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'retention_days'").get()?.value || '365');
  const cutoff = Date.now() - (retentionDays * 86400 * 1000);
  const deleted = db.prepare('DELETE FROM messages WHERE received_at < ?').run(cutoff);
  if (deleted.changes > 0) {
    console.log(`🗑 Deleted ${deleted.changes} old messages (retention: ${retentionDays} days)`);
  }
}

// ─── EXPRESS API ───────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve frontend
app.use(express.static(path.join(__dirname, '..')));

// ── AUTH MIDDLEWARE ──
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── AUTH ROUTES ──
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ success: true });
});

// ── DOMAINS ──
app.get('/api/domains', authMiddleware, (req, res) => {
  const domains = db.prepare('SELECT * FROM domains ORDER BY created_at DESC').all();
  res.json(domains);
});

app.post('/api/domains', authMiddleware, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Tên miền là bắt buộc' });
  try {
    db.prepare('INSERT INTO domains (id, name, description) VALUES (?, ?, ?)').run(uid(), name.toLowerCase(), description || '');
    res.json({ success: true });
  } catch {
    res.status(409).json({ error: 'Tên miền đã tồn tại' });
  }
});

app.delete('/api/domains/:id', authMiddleware, (req, res) => {
  const domain = db.prepare('SELECT * FROM domains WHERE id = ?').get(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM email_addresses WHERE domain = ?').run(domain.name);
  db.prepare('DELETE FROM domains WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── EMAIL ADDRESSES ──
app.get('/api/emails', authMiddleware, (req, res) => {
  const { search, domain, page = 1, limit = 50 } = req.query;
  let query = 'SELECT * FROM email_addresses WHERE 1=1';
  const params = [];
  if (search) { query += ' AND email LIKE ?'; params.push(`%${search}%`); }
  if (domain)  { query += ' AND domain = ?'; params.push(domain); }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  const emails = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as count FROM email_addresses').get().count;
  res.json({ emails, total });
});

app.post('/api/emails', authMiddleware, (req, res) => {
  const { local, domain, note } = req.body;
  if (!local || !domain) return res.status(400).json({ error: 'Thiếu thông tin' });
  const domainRecord = db.prepare('SELECT * FROM domains WHERE name = ?').get(domain);
  if (!domainRecord) return res.status(400).json({ error: 'Tên miền không tồn tại' });
  const email = `${local.toLowerCase()}@${domain}`;
  try {
    db.prepare('INSERT INTO email_addresses (id, email, local, domain, note) VALUES (?,?,?,?,?)').run(uid(), email, local.toLowerCase(), domain, note || '');
    res.json({ success: true, email });
  } catch {
    res.status(409).json({ error: 'Địa chỉ email đã tồn tại' });
  }
});

app.post('/api/emails/bulk', authMiddleware, (req, res) => {
  const { emails } = req.body; // Array of { local, domain, note }
  const results = { created: 0, skipped: 0, errors: [] };
  const insertStmt = db.prepare('INSERT OR IGNORE INTO email_addresses (id, email, local, domain, note) VALUES (?,?,?,?,?)');
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      const email = `${item.local.toLowerCase()}@${item.domain}`;
      const changes = insertStmt.run(uid(), email, item.local.toLowerCase(), item.domain, item.note || 'Bulk create').changes;
      if (changes > 0) results.created++; else results.skipped++;
    }
  });
  insertMany(emails);
  res.json(results);
});

app.delete('/api/emails/:id', authMiddleware, (req, res) => {
  const email = db.prepare('SELECT * FROM email_addresses WHERE id = ?').get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM messages WHERE to_addr = ?').run(email.email);
  db.prepare('DELETE FROM email_addresses WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// CSV import
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/emails/import-csv', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  const results = { created: 0, skipped: 0 };
  const insertStmt = db.prepare('INSERT OR IGNORE INTO email_addresses (id, email, local, domain, note) VALUES (?,?,?,?,?)');
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      const email = (row.email || row.Email || '').toLowerCase().trim();
      if (!email.includes('@')) continue;
      const [local, domain] = email.split('@');
      if (!local || !domain) continue;
      const changes = insertStmt.run(uid(), email, local, domain, row.note || row.Note || '').changes;
      if (changes > 0) results.created++; else results.skipped++;
    }
  });
  insertMany(records);
  res.json(results);
});

// ── MESSAGES ──
app.get('/api/messages', authMiddleware, (req, res) => {
  const { to, search, unread, page = 1, limit = 50 } = req.query;
  let query = 'SELECT * FROM messages WHERE 1=1';
  const params = [];
  if (to)     { query += ' AND to_addr = ?'; params.push(to); }
  if (search) { query += ' AND (subject LIKE ? OR from_addr LIKE ? OR body_text LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (unread === '1') { query += ' AND is_read = 0'; }
  query += ' ORDER BY received_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  const messages = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const unreadCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE is_read = 0').get().count;
  res.json({ messages, total, unreadCount });
});

app.get('/api/messages/:id', authMiddleware, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json(msg);
});

app.patch('/api/messages/mark-all-read', authMiddleware, (req, res) => {
  db.prepare('UPDATE messages SET is_read = 1').run();
  res.json({ success: true });
});

app.delete('/api/messages/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── STATS ──
app.get('/api/stats', authMiddleware, (req, res) => {
  res.json({
    domains:  db.prepare('SELECT COUNT(*) as c FROM domains').get().c,
    emails:   db.prepare('SELECT COUNT(*) as c FROM email_addresses').get().c,
    messages: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
    unread:   db.prepare('SELECT COUNT(*) as c FROM messages WHERE is_read = 0').get().c,
  });
});

// ── SETTINGS ──
app.get('/api/settings', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.post('/api/settings', authMiddleware, (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const upsertMany = db.transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) upsert.run(k, String(v));
  });
  upsertMany(req.body);
  res.json({ success: true });
});

// ── ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ─── START ──────────────────────────────────────────────────────────

// Start SMTP server
smtpServer.listen(SMTP_PORT, '0.0.0.0', () => {
  console.log(`📬 SMTP Server listening on port ${SMTP_PORT}`);
  console.log(`   → Make sure port ${SMTP_PORT} is open in your firewall!`);
  console.log(`   → Add MX record: @ → mail.yourdomain.com (priority 10)`);
});

smtpServer.on('error', err => {
  console.error('SMTP error:', err.message);
  if (err.code === 'EACCES') {
    console.error(`❌ Permission denied for port ${SMTP_PORT}. Try: sudo node server.js`);
  }
});

// Start HTTP API
app.listen(PORT, () => {
  console.log(`🚀 MailMaster API running at http://localhost:${PORT}`);
  console.log(`   Frontend: http://localhost:${PORT}`);
  console.log(`   API Docs: http://localhost:${PORT}/api/stats`);
  console.log('');
  console.log('Default credentials: admin / admin123');
});
