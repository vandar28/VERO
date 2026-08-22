require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const uuid = require('uuid').v4;
const { Pool } = require('pg');

const storage = require('./storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL не задан. Для Render нужен внешний PostgreSQL (например Neon Free).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function sqlPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function dbRun(sql, p) {
  try {
    const result = await pool.query(sqlPg(sql), p || []);
    return result;
  } catch (e) {
    console.error('❌ SQL:', e.message, '\n', sql);
    throw e;
  }
}

async function dbGet(sql, p) {
  const result = await pool.query(sqlPg(sql), p || []);
  return result.rows[0] || null;
}

async function dbAll(sql, p) {
  const result = await pool.query(sqlPg(sql), p || []);
  return result.rows;
}

// PostgreSQL хранит данные постоянно. Эти функции оставлены как совместимость
// со старой версией проекта: GitHub больше НЕ используется как база данных.
async function saveDB() {}
async function backupNow() {}

async function startDB() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL DEFAULT '',
      avatar TEXT DEFAULT NULL,
      is_temp INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NULL,
      is_online INTEGER DEFAULT 0,
      is_typing INTEGER DEFAULT 0,
      typing_to INTEGER DEFAULT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      original_name TEXT,
      filename TEXT,
      file_type TEXT,
      file_size BIGINT,
      upload_date TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      from_user INTEGER REFERENCES users(id) ON DELETE CASCADE,
      to_user INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      message_text TEXT,
      file_name TEXT,
      file_type TEXT,
      file_path TEXT,
      file_size BIGINT DEFAULT 0,
      duration_seconds DOUBLE PRECISION DEFAULT NULL,
      media_kind TEXT DEFAULT NULL,
      is_read INTEGER DEFAULT 0,
      deleted_for_sender INTEGER DEFAULT 0,
      deleted_for_receiver INTEGER DEFAULT 0,
      forward_from TEXT DEFAULT NULL,
      forward_from_name TEXT DEFAULT NULL,
      is_self_destruct INTEGER DEFAULT 0,
      destruct_after_view INTEGER DEFAULT 0,
      reply_to INTEGER DEFAULT NULL,
      reply_text TEXT DEFAULT NULL,
      reply_sender TEXT DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS avatars (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      avatar_path TEXT,
      is_active INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS shared_pins (
      id SERIAL PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      chat_user1 INTEGER,
      chat_user2 INTEGER,
      pinned_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS private_pins (
      id SERIAL PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      chat_user1 INTEGER,
      chat_user2 INTEGER,
      pinned_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      reaction TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS file_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      granted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Миграции для уже существующей PostgreSQL базы.
  const migrations = [
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION DEFAULT NULL",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_kind TEXT DEFAULT NULL",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(sender_id, receiver_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_messages_receiver_read ON messages(receiver_id, is_read)",
    "CREATE INDEX IF NOT EXISTS idx_friends_users ON friends(from_user, to_user, status)",
    "CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)"
  ];
  for (const migration of migrations) {
    try { await dbRun(migration); } catch (e) { console.warn('⚠️ Миграция:', e.message); }
  }

  await createAdminAccount();
  console.log('✅ PostgreSQL DB OK');
}

async function createAdminAccount() {
  const adminEmail = process.env.ADMIN_EMAIL || 'ad6@gmail.com';
  const adminUsername = process.env.ADMIN_USERNAME || 'ad';
  const adminPassword = process.env.ADMIN_PASSWORD || 'change-this-admin-password';

  const existing = await dbGet('SELECT * FROM users WHERE email=?', [adminEmail]);
  if (!existing) {
    const hash = await bcrypt.hash(adminPassword, 10);
    await dbRun(
      'INSERT INTO users (username, email, password, is_temp) VALUES (?, ?, ?, 0)',
      [adminUsername, adminEmail, hash]
    );
    console.log('✅ Админ создан:', adminUsername, adminEmail);
  } else {
    console.log('🔄 Админ уже существует');
  }
}

async function deleteUserData(userId) {
  const avatars = await dbAll("SELECT avatar_path FROM avatars WHERE user_id=?", [userId]);
  for (const a of avatars) {
    if (a.avatar_path) {
      try { await storage.deleteFile(a.avatar_path); } catch (e) {}
    }
  }

  const files = await dbAll("SELECT filename FROM files WHERE user_id=?", [userId]);
  for (const f of files) {
    if (f.filename) {
      try { await storage.deleteFile(f.filename); } catch (e) {}
    }
  }

  const messageFiles = await dbAll(
    "SELECT file_path FROM messages WHERE (sender_id=? OR receiver_id=?) AND file_path IS NOT NULL",
    [userId, userId]
  );
  for (const f of messageFiles) {
    if (f.file_path) {
      try { await storage.deleteFile(f.file_path); } catch (e) {}
    }
  }

  await dbRun("DELETE FROM users WHERE id=?", [userId]);
}

const UPLOADS = './public/uploads';
const AVATARS = './public/avatars';

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(AVATARS)) fs.mkdirSync(AVATARS, { recursive: true });

const storageMulter = multer.diskStorage({
  destination: function(req, file, cb) {
    const tempDir = './temp';
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    cb(null, tempDir);
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '_' + file.originalname.replace(/[^\w.\- ]/g, '_'));
  }
});

const avatarStorageMulter = multer.diskStorage({
  destination: function(req, file, cb) {
    const tempDir = './temp';
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    cb(null, tempDir);
  },
  filename: function(req, file, cb) {
    cb(null, 'avatar_' + Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storageMulter,
  limits: { fileSize: Number(process.env.MAX_FILE_SIZE || 100) * 1024 * 1024 },
  fileFilter: function(req, file, cb) { cb(null, true); }
});

const uploadAvatar = multer({
  storage: avatarStorageMulter,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images'));
  }
});

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, function(err, u) {
    if (err) return res.status(403).json({ error: 'Bad token' });
    req.userId = u.id;
    next();
  });
}

async function adminAuth(req, res, next) {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
    if (!user || user.email !== (process.env.ADMIN_EMAIL || 'ad6@gmail.com')) {
      return res.status(403).json({ error: 'Только для администратора' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: 'Ошибка БД' });
  }
}

// ===== МАРШРУТЫ =====

app.post('/api/register', uploadAvatar.single('avatar'), async function(req, res) {
  const b = req.body; 
  const isTemp = b.is_temp === 'true' || b.is_temp === true;
  
  if (!isTemp) { 
    const permCount = (await dbGet('SELECT COUNT(*) as c FROM users WHERE is_temp=0') || {}).c || 0; 
    if (permCount >= 20) return res.status(400).json({ error: 'Лимит' }); 
  }
  
  if (await dbGet('SELECT id FROM users WHERE email=? OR username=?', [b.email, b.username])) {
    return res.status(400).json({ error: 'Существует' });
  }
  
  const hash = isTemp ? '' : await bcrypt.hash(b.password || '', 10);
  let avatarPath = null;
  
  if (req.file) {
    const fileBuffer = fs.readFileSync(req.file.path);
    avatarPath = await storage.uploadFile(fileBuffer, req.file.filename, req.file.mimetype, 'avatars');
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
  
  await dbRun('INSERT INTO users (username, email, password, avatar, is_temp) VALUES (?, ?, ?, ?, ?)', 
    [b.username, b.email, hash, avatarPath, isTemp ? 1 : 0]);
  
  const user = await dbGet('SELECT * FROM users WHERE email=?', [b.email]);
  if (avatarPath) await dbRun('INSERT INTO avatars (user_id, avatar_path, is_active) VALUES (?, ?, 1)', [user.id, avatarPath]);
  
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: isTemp ? '24h' : '30d' });
  
  backupNow('регистрация');
  
  res.json({ 
    token: token, 
    user: { 
      id: user.id, 
      username: b.username, 
      email: b.email, 
      avatar: avatarPath, 
      is_temp: isTemp 
    } 
  });
});

app.post('/api/login', async function(req, res) {
  const b = req.body; 
  const user = await dbGet('SELECT * FROM users WHERE email=?', [b.email]);
  if (!user) return res.status(401).json({ error: 'Неверно' });
  
  if (user.is_temp) { 
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '24h' }); 
    return res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        email: user.email, 
        avatar: user.avatar, 
        is_temp: true 
      } 
    }); 
  }
  
  if (!(await bcrypt.compare(b.password, user.password))) {
    return res.status(401).json({ error: 'Неверно' });
  }
  
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ 
    token, 
    user: { 
      id: user.id, 
      username: user.username, 
      email: user.email, 
      avatar: user.avatar, 
      is_temp: false 
    } 
  });
});

app.post('/api/delete-temp-account', auth, async function(req, res) {
  const user = await dbGet('SELECT * FROM users WHERE id=? AND is_temp=1', [req.userId]);
  if (!user) return res.status(400).json({ error: 'Не врем.' }); 
  await deleteUserData(req.userId); 
   
  backupNow('удаление временного аккаунта');
  res.json({ message: 'Удалён' });
});

app.post('/api/keep-alive', auth, async function(req, res) { 
  res.json({ alive: true }); 
});

app.post('/api/user/change-username', auth, async function(req, res) {
  const newUsername = req.body.username;
  if (!newUsername || newUsername.trim().length < 2) {
    return res.status(400).json({ error: 'Имя должно содержать минимум 2 символа' });
  }
  const trimmed = newUsername.trim();
  
  const existing = await dbGet('SELECT id FROM users WHERE username=? AND id!=?', [trimmed, req.userId]);
  if (existing) {
    return res.status(400).json({ error: 'Это имя уже занято' });
  }
  
  await dbRun('UPDATE users SET username=? WHERE id=?', [trimmed, req.userId]);
  
  
  const user = await dbGet('SELECT id, username, email, avatar, is_temp FROM users WHERE id=?', [req.userId]);
  backupNow('смена имени');
  res.json({ ok: true, user: user });
});

app.post('/api/user/online', auth, async function(req, res) {
  await dbRun("UPDATE users SET is_online=1, last_seen=NOW() WHERE id=?", [req.userId]);
  res.json({ ok: true });
});

app.post('/api/user/offline', auth, async function(req, res) {
  await dbRun("UPDATE users SET is_online=0, last_seen=NOW() WHERE id=?", [req.userId]);
  res.json({ ok: true });
});

app.post('/api/user/typing', auth, async function(req, res) {
  const toId = req.body.to_id;
  if (!toId) return res.status(400).json({ error: 'to_id required' });
  await dbRun("UPDATE users SET is_typing=1, typing_to=? WHERE id=?", [toId, req.userId]);
  res.json({ ok: true });
});

app.post('/api/user/stop-typing', auth, async function(req, res) {
  await dbRun("UPDATE users SET is_typing=0, typing_to=NULL WHERE id=?", [req.userId]);
  res.json({ ok: true });
});

app.get('/api/user/status/:userId', auth, async function(req, res) {
  const user = await dbGet('SELECT is_online, last_seen, is_typing, typing_to FROM users WHERE id=?', [req.params.userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ 
    is_online: user.is_online || 0,
    last_seen: user.last_seen,
    is_typing: user.is_typing || 0,
    typing_to: user.typing_to
  });
});

app.get('/api/admin/stats', auth, adminAuth, async function(req, res) {
  const totalUsers = await dbGet('SELECT COUNT(*) as count FROM users WHERE id!=?', [req.userId]);
  const totalTemp = await dbGet('SELECT COUNT(*) as count FROM users WHERE is_temp=1');
  const totalMessages = await dbGet('SELECT COUNT(*) as count FROM messages');
  const totalFiles = await dbGet('SELECT COUNT(*) as count FROM files');
  res.json({
    total_users: totalUsers?.count || 0,
    temp_users: totalTemp?.count || 0,
    total_messages: totalMessages?.count || 0,
    total_files: totalFiles?.count || 0
  });
});

app.delete('/api/admin/user/:userId', auth, adminAuth, async function(req, res) {
  const userId = parseInt(req.params.userId);
  if (userId === req.userId) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }
  const user = await dbGet('SELECT * FROM users WHERE id=?', [userId]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  deleteUserData(userId);
  
  backupNow('админ удаление пользователя');
  res.json({ ok: true, message: 'Пользователь удален' });
});

app.get('/api/admin/users', auth, adminAuth, async function(req, res) {
  const users = await dbAll("SELECT u.id, u.username, u.email, u.is_temp, CASE WHEN fa.user_id IS NOT NULL THEN 1 ELSE 0 END as has_file_access FROM users u LEFT JOIN file_access fa ON u.id = fa.user_id WHERE u.id != ? ORDER BY u.id", [req.userId]);
  res.json({ users: users });
});

app.post('/api/admin/grant-file-access/:userId', auth, adminAuth, async function(req, res) {
  const userId = parseInt(req.params.userId);
  const existing = await dbGet('SELECT * FROM file_access WHERE user_id=?', [userId]);
  if (!existing) {
    await dbRun('INSERT INTO file_access (user_id, granted_by) VALUES (?, ?)', [userId, req.userId]);
  }
  backupNow('выдача доступа к файлам');
  res.json({ ok: true, message: 'Доступ выдан' });
});

app.post('/api/admin/revoke-file-access/:userId', auth, adminAuth, async function(req, res) {
  await dbRun('DELETE FROM file_access WHERE user_id=?', [req.params.userId]);
  backupNow('отзыв доступа к файлам');
  res.json({ ok: true, message: 'Доступ отозван' });
});

// ===== АВАТАРКИ =====
app.post('/api/avatar', auth, uploadAvatar.single('avatar'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    const fileBuffer = fs.readFileSync(req.file.path);
    const avatarPath = await storage.uploadFile(fileBuffer, req.file.filename, req.file.mimetype, 'avatars');
    
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    await dbRun("UPDATE avatars SET is_active=0 WHERE user_id=? AND is_active=1", [req.userId]);
    await dbRun('INSERT INTO avatars (user_id, avatar_path, is_active) VALUES (?, ?, 1)', [req.userId, avatarPath]);
    await dbRun('UPDATE users SET avatar=? WHERE id=?', [avatarPath, req.userId]);
    
    backupNow('смена аватарки');
    res.json({ avatar: avatarPath });
  } catch (error) {
    console.error('❌ Ошибка загрузки аватарки:', error);
    res.status(500).json({ error: 'Ошибка загрузки аватарки' });
  }
});

app.get('/api/avatars', auth, async function(req, res) { 
  res.json({ avatars: await dbAll("SELECT * FROM avatars WHERE user_id=? ORDER BY created_at DESC", [req.userId]) }); 
});

app.get('/api/user/:userId/avatars', auth, async function(req, res) { 
  res.json({ avatars: await dbAll("SELECT id, avatar_path, is_active, created_at FROM avatars WHERE user_id=? ORDER BY created_at DESC", [req.params.userId]) }); 
});

app.post('/api/avatars/:id/activate', auth, async function(req, res) {
  const avatar = await dbGet("SELECT * FROM avatars WHERE id=? AND user_id=?", [req.params.id, req.userId]);
  if (!avatar) return res.status(404);
  await dbRun("UPDATE avatars SET is_active=0 WHERE user_id=?", [req.userId]);
  await dbRun("UPDATE avatars SET is_active=1 WHERE id=?", [req.params.id]);
  await dbRun('UPDATE users SET avatar=? WHERE id=?', [avatar.avatar_path, req.userId]);
  backupNow('активация аватарки');
  res.json({ avatar: avatar.avatar_path });
});

app.delete('/api/avatars/:id', auth, async function(req, res) {
  const avatar = await dbGet("SELECT * FROM avatars WHERE id=? AND user_id=?", [req.params.id, req.userId]);
  if (!avatar) return res.status(404);
  if (avatar.is_active) return res.status(400).json({ error: 'Нельзя удалить текущую' });
  
  if (avatar.avatar_path && avatar.avatar_path.startsWith('http')) {
    storage.deleteFile(avatar.avatar_path).catch(function(err) {
      console.error('❌ Ошибка удаления из Cloudinary:', err);
    });
  } else {
    const fp = path.join(__dirname, 'public', avatar.avatar_path);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  
  await dbRun("DELETE FROM avatars WHERE id=?", [req.params.id]);
  backupNow('удаление аватарки');
  res.json({ message: 'Удалена' });
});

app.get('/api/check-file-access', auth, async function(req, res) {
  const user = await dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
  if (user && user.email === 'ad6@gmail.com') {
    return res.json({ hasAccess: true, isAdmin: true });
  }
  const access = await dbGet('SELECT * FROM file_access WHERE user_id=?', [req.userId]);
  res.json({ hasAccess: !!access, isAdmin: false });
});

app.post('/api/upload', auth, upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400);
    
    const user = await dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
    if (!user || user.email !== 'ad6@gmail.com') {
      const access = await dbGet('SELECT * FROM file_access WHERE user_id=?', [req.userId]);
      if (!access) return res.status(403).json({ error: 'Нет доступа к файлам' });
    }
    
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileUrl = await storage.uploadFile(fileBuffer, req.file.originalname, req.file.mimetype, 'files');
    
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    const id = uuid();
    await dbRun('INSERT INTO files (id, user_id, original_name, filename, file_type, file_size) VALUES (?, ?, ?, ?, ?, ?)', 
      [id, req.userId, req.file.originalname, fileUrl, req.file.mimetype, req.file.size]);
    
    backupNow('загрузка файла');
    res.json({ ok: true, url: fileUrl });
  } catch (error) {
    console.error('❌ Ошибка загрузки файла:', error);
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
});

app.get('/api/files', auth, async function(req, res) {
  const user = await dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
  if (user && user.email === 'ad6@gmail.com') {
    return res.json({ files: await dbAll('SELECT * FROM files WHERE user_id=? ORDER BY upload_date DESC', [req.userId]) });
  }
  const access = await dbGet('SELECT * FROM file_access WHERE user_id=?', [req.userId]);
  if (!access) {
    return res.status(403).json({ error: 'Нет доступа к файлам', noAccess: true });
  }
  res.json({ files: await dbAll('SELECT * FROM files WHERE user_id=? ORDER BY upload_date DESC', [req.userId]) });
});

// ===== ДРУЗЬЯ =====
app.post('/api/friends/request/:uid', auth, async function(req, res) {
  const toId = parseInt(req.params.uid);
  if (req.userId === toId) return res.status(400).json({ error: 'Self' });
  const existing = await dbGet("SELECT * FROM friends WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)", [req.userId, toId, toId, req.userId]);
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'Уже друзья' });
    if (existing.status === 'pending' && existing.from_user === req.userId) return res.status(400).json({ error: 'Уже отправлена' });
    if (existing.status === 'pending' && existing.from_user === toId) { 
      await dbRun("UPDATE friends SET status='accepted' WHERE id=?", [existing.id]); 
      backupNow('автопринятие друга');
      return res.json({ ok: true, auto: true }); 
    }
  }
  await dbRun('INSERT INTO friends (from_user, to_user, status) VALUES (?, ?, ?)', [req.userId, toId, 'pending']);
  backupNow('запрос в друзья');
  res.json({ ok: true });
});

app.post('/api/friends/accept/:uid', auth, async function(req, res) {
  const r = await dbGet("SELECT * FROM friends WHERE from_user=? AND to_user=? AND status='pending'", [req.params.uid, req.userId]);
  if (!r) return res.status(404);
  await dbRun("UPDATE friends SET status='accepted' WHERE id=?", [r.id]);
  backupNow('принятие друга');
  res.json({ ok: true });
});

app.post('/api/friends/reject/:uid', auth, async function(req, res) {
  await dbRun("DELETE FROM friends WHERE from_user=? AND to_user=? AND status='pending'", [req.params.uid, req.userId]);
  backupNow('отклонение друга');
  res.json({ ok: true });
});

app.delete('/api/friends/:uid', auth, async function(req, res) {
  await dbRun("DELETE FROM friends WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)", [req.userId, req.params.uid, req.params.uid, req.userId]);
  backupNow('удаление друга');
  res.json({ ok: true });
});

app.get('/api/friends', auth, async function(req, res) {
  const friends = await dbAll("SELECT u.id, u.username, u.avatar FROM friends f JOIN users u ON u.id = CASE WHEN f.from_user=? THEN f.to_user ELSE f.from_user END WHERE (f.from_user=? OR f.to_user=?) AND f.status='accepted'", [req.userId, req.userId, req.userId]);
  const seen = {}, unique = [];
  friends.forEach(function(f) { if (!seen[f.id]) { seen[f.id] = true; unique.push(f); } });
  res.json({ friends: unique });
});

app.get('/api/friends/requests', auth, async function(req, res) {
  res.json({ requests: await dbAll("SELECT f.id, f.from_user, u.username, u.avatar FROM friends f JOIN users u ON f.from_user=u.id WHERE f.to_user=? AND f.status='pending'", [req.userId]) });
});

// ===== СООБЩЕНИЯ =====
app.post('/api/messages/:fid', auth, upload.single('file'), async function(req, res) {
  try {
    const fid = parseInt(req.params.fid);
    const friend = await dbGet("SELECT * FROM friends WHERE ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?)) AND status='accepted'", [req.userId, fid, fid, req.userId]);
    if (!friend) return res.status(403).json({ error: 'Не друзья' });
    
    let text = req.body.message_text || '';
    let filePath = null;
    let fileName = null;
    let fileType = null;
    let durationSeconds = req.body.duration_seconds ? Number(req.body.duration_seconds) : null;
    let mediaKind = req.body.media_kind || null;
    
    if (req.file) {
      fileName = req.file.originalname;
      fileType = req.file.mimetype;
      const maxCloudinaryBytes = (fileType.startsWith('video/') || fileType.startsWith('audio/')) ? 100 * 1024 * 1024 : 10 * 1024 * 1024;
      if (req.file.size > maxCloudinaryBytes) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(413).json({ error: 'Файл слишком большой для бесплатного хранилища', max_mb: Math.round(maxCloudinaryBytes / 1024 / 1024) });
      }
      
      const uploadDir = path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      
      const localFileName = Date.now() + '_' + fileName;
      const localFilePath = path.join(uploadDir, localFileName);
      
      fs.copyFileSync(req.file.path, localFilePath);
      console.log(`📁 Файл скопирован в public/uploads/: ${localFileName}`);
      
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      try {
        const fileBuffer = fs.readFileSync(localFilePath);
        const uploaded = await storage.uploadMedia(fileBuffer, fileName, fileType, 'uploads');
        filePath = uploaded.url;
        if (uploaded.duration && Number.isFinite(uploaded.duration)) durationSeconds = uploaded.duration;
        mediaKind = fileType.startsWith('video/') ? 'video' : fileType.startsWith('audio/') ? 'audio' : fileType.startsWith('image/') ? 'image' : 'file';
        if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
      } catch (uploadError) {
        if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
        return res.status(413).json({ error: 'Файл не удалось сохранить в облако', details: uploadError.message });
      }
    }
    
    const forwardFrom = req.body.forward_from || null;
    const forwardFromName = req.body.forward_from_name || null;
    
    if (forwardFrom && req.body.forward_file_path) {
      fileName = req.body.forward_file_name || 'file';
      fileType = req.body.forward_file_type || 'application/octet-stream';
      filePath = req.body.forward_file_path;
      if (req.body.forward_duration_seconds) durationSeconds = Number(req.body.forward_duration_seconds);
      if (!mediaKind && fileType) mediaKind = fileType.startsWith('video/') ? 'video' : fileType.startsWith('audio/') ? 'audio' : fileType.startsWith('image/') ? 'image' : 'file';
    }
    
    const isSelfDestruct = req.body.is_self_destruct === 'true' || req.body.is_self_destruct === true ? 1 : 0;
    
    const replyTo = req.body.reply_to || null;
    const replyText = req.body.reply_text || null;
    const replySender = req.body.reply_sender || null;
    
    await dbRun('INSERT INTO messages (sender_id, receiver_id, message_text, file_name, file_type, file_path, file_size, duration_seconds, media_kind, forward_from, forward_from_name, is_self_destruct, reply_to, reply_text, reply_sender) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.userId, fid, text, fileName, fileType, filePath, req.file ? req.file.size : 0, durationSeconds, mediaKind, forwardFrom, forwardFromName, isSelfDestruct, replyTo, replyText, replySender]);
    
    
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Ошибка отправки сообщения:', error);
    res.status(500).json({ error: 'Ошибка отправки сообщения' });
  }
});

app.put('/api/messages/:id', auth, async function(req, res) {
  try {
    const msgId = req.params.id;
    const newText = req.body.message_text;
    
    if (!newText || newText.trim().length === 0) {
      return res.status(400).json({ error: 'Текст сообщения не может быть пустым' });
    }
    
    const msg = await dbGet('SELECT * FROM messages WHERE id=?', [msgId]);
    if (!msg) {
      return res.status(404).json({ error: 'Сообщение не найдено' });
    }
    
    if (msg.sender_id !== req.userId) {
      return res.status(403).json({ error: 'Вы не можете изменять чужие сообщения' });
    }
    
    await dbRun('UPDATE messages SET message_text=? WHERE id=?', [newText.trim(), msgId]);
    
    backupNow('изменение сообщения');
    res.json({ ok: true, message: 'Сообщение изменено' });
  } catch (error) {
    console.error('❌ Ошибка изменения сообщения:', error);
    res.status(500).json({ error: 'Ошибка изменения сообщения' });
  }
});

app.post('/api/messages/:id/destruct', auth, async function(req, res) {
  const msg = await dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Не найдено' });
  
  if (msg.is_self_destruct && msg.receiver_id === req.userId) {
    if (msg.file_path && msg.file_path.startsWith('http')) {
      storage.deleteFile(msg.file_path).catch(function(err) {
        console.error('❌ Ошибка удаления файла из Cloudinary:', err);
      });
    }
    await dbRun("UPDATE messages SET deleted_for_receiver=1, file_path=NULL, file_name=NULL, file_type=NULL, message_text='[Одноразовое фото удалено]' WHERE id=?", [req.params.id]);
    
    backupNow('удаление одноразового фото');
    res.json({ ok: true });
  } else {
    res.status(403).json({ error: 'Нельзя удалить' });
  }
});

app.post('/api/messages/:id/media-duration', auth, async function(req, res) {
  try {
    const duration = Number(req.body.duration_seconds);
    if (!Number.isFinite(duration) || duration < 0 || duration > 86400) {
      return res.status(400).json({ error: 'Некорректная длительность' });
    }
    const msg = await dbGet('SELECT id, sender_id, receiver_id FROM messages WHERE id=?', [req.params.id]);
    if (!msg || (msg.sender_id !== req.userId && msg.receiver_id !== req.userId)) {
      return res.status(404).json({ error: 'Сообщение не найдено' });
    }
    await dbRun('UPDATE messages SET duration_seconds=? WHERE id=?', [duration, req.params.id]);
    res.json({ ok: true, duration_seconds: duration });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сохранения длительности' });
  }
});

app.get('/api/messages/:fid', auth, async function(req, res) {
  await dbRun('UPDATE messages SET is_read=1 WHERE receiver_id=? AND sender_id=? AND deleted_for_receiver=0', [req.userId, req.params.fid]);
  const messages = await dbAll('SELECT m.*, s.username, s.avatar FROM messages m JOIN users s ON m.sender_id=s.id WHERE ((m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)) AND NOT (m.sender_id=? AND m.deleted_for_sender=1) AND NOT (m.receiver_id=? AND m.deleted_for_receiver=1) ORDER BY m.created_at ASC', [req.userId, req.params.fid, req.params.fid, req.userId, req.userId, req.userId]);
  
  const msgIds = messages.map(function(m){return m.id});
  if (msgIds.length > 0) {
    const placeholders = msgIds.map(function(){return '?'}).join(',');
    const reactions = await dbAll("SELECT message_id, reaction, user_id FROM reactions WHERE message_id IN (" + placeholders + ")", msgIds);
    const reactionMap = {};
    reactions.forEach(function(r){
      if (!reactionMap[r.message_id]) reactionMap[r.message_id] = {};
      if (!reactionMap[r.message_id][r.reaction]) reactionMap[r.message_id][r.reaction] = [];
      reactionMap[r.message_id][r.reaction].push(r.user_id);
    });
    messages.forEach(function(m){
      m.reactions = reactionMap[m.id] || {};
    });
  }
  
  res.json({ messages: messages });
});

app.post('/api/messages/:id/delete', auth, async function(req, res) {
  const msg = await dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  
  const deleteFor = req.body.delete_for || 'me';
  
  if (deleteFor === 'all') {
    if (msg.sender_id !== req.userId) {
      return res.status(403).json({ error: 'Вы не можете удалить чужое сообщение у всех' });
    }
    if (msg.file_path && msg.file_path.startsWith('http')) {
      storage.deleteFile(msg.file_path).catch(function(err) {
        console.error('❌ Ошибка удаления файла из Cloudinary:', err);
      });
    }
    await dbRun("UPDATE messages SET deleted_for_sender=1, deleted_for_receiver=1 WHERE id=?", [req.params.id]);
    await dbRun("DELETE FROM shared_pins WHERE message_id=?", [req.params.id]);
    await dbRun("DELETE FROM private_pins WHERE message_id=?", [req.params.id]);
    await dbRun("DELETE FROM reactions WHERE message_id=?", [req.params.id]);
    
    backupNow('удаление сообщения у всех');
    return res.json({ ok: true, message: 'Удалено у всех' });
  }
  
  if (msg.sender_id === req.userId) {
    await dbRun("UPDATE messages SET deleted_for_sender=1 WHERE id=?", [req.params.id]);
  } else {
    await dbRun("UPDATE messages SET deleted_for_receiver=1 WHERE id=?", [req.params.id]);
  }
  
  backupNow('удаление сообщения у себя');
  res.json({ ok: true, message: 'Удалено у вас' });
});

app.post('/api/messages/:id/react', auth, async function(req, res) {
  const msg = await dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  
  const reaction = req.body.reaction;
  if (!reaction) return res.status(400).json({ error: 'Реакция не указана' });
  
  const userReactions = await dbAll("SELECT * FROM reactions WHERE message_id=? AND user_id=?", [req.params.id, req.userId]);
  
  let existing = null;
  for(var i=0; i<userReactions.length; i++){
    if(userReactions[i].reaction === reaction){
      existing = userReactions[i];
      break;
    }
  }
  
  if (existing) {
    await dbRun("DELETE FROM reactions WHERE id=?", [existing.id]);
    
    backupNow('удаление реакции');
    return res.json({ ok: true, action: 'removed' });
  }
  
  if (userReactions.length >= 2) {
    return res.status(400).json({ error: 'Можно поставить максимум 2 реакции' });
  }
  
  await dbRun("INSERT INTO reactions (message_id, user_id, reaction) VALUES (?, ?, ?)", [req.params.id, req.userId, reaction]);
  
  backupNow('добавление реакции');
  res.json({ ok: true, action: 'added' });
});

app.post('/api/messages/:id/pin/shared', auth, async function(req, res) {
  const msg = await dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404);
  if (msg.sender_id !== req.userId && msg.receiver_id !== req.userId) return res.status(403).json({ error: 'Вы не участник чата' });
  const u1 = Math.min(msg.sender_id, msg.receiver_id);
  const u2 = Math.max(msg.sender_id, msg.receiver_id);
  const existing = await dbGet("SELECT * FROM shared_pins WHERE message_id=? AND pinned_by=?", [req.params.id, req.userId]);
  if (existing) return res.status(400).json({ error: 'Уже закреплено вами' });
  await dbRun('INSERT INTO shared_pins (message_id, chat_user1, chat_user2, pinned_by) VALUES (?, ?, ?, ?)', [req.params.id, u1, u2, req.userId]);
  
  backupNow('закрепление общее');
  res.json({ ok: true });
});

app.post('/api/messages/:id/pin/private', auth, async function(req, res) {
  const msg = await dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404);
  if (msg.sender_id !== req.userId && msg.receiver_id !== req.userId) return res.status(403).json({ error: 'Вы не участник чата' });
  const u1 = Math.min(msg.sender_id, msg.receiver_id);
  const u2 = Math.max(msg.sender_id, msg.receiver_id);
  const existing = await dbGet("SELECT * FROM private_pins WHERE message_id=? AND pinned_by=?", [req.params.id, req.userId]);
  if (existing) return res.status(400).json({ error: 'Уже закреплено вами' });
  await dbRun('INSERT INTO private_pins (message_id, chat_user1, chat_user2, pinned_by) VALUES (?, ?, ?, ?)', [req.params.id, u1, u2, req.userId]);
  
  backupNow('закрепление личное');
  res.json({ ok: true });
});

app.post('/api/messages/:id/unpin/shared', auth, async function(req, res) {
  await dbRun("DELETE FROM shared_pins WHERE message_id=? AND pinned_by=?", [req.params.id, req.userId]);
  
  backupNow('открепление общее');
  res.json({ ok: true });
});

app.post('/api/messages/:id/unpin/private', auth, async function(req, res) {
  await dbRun("DELETE FROM private_pins WHERE message_id=? AND pinned_by=?", [req.params.id, req.userId]);
  
  backupNow('открепление личное');
  res.json({ ok: true });
});

app.get('/api/pinned/shared/:fid', auth, async function(req, res) {
  const fid = parseInt(req.params.fid);
  const u1 = Math.min(req.userId, fid);
  const u2 = Math.max(req.userId, fid);
  const pinned = await dbAll("SELECT sp.*, m.message_text, m.file_name, m.file_type, m.file_path, m.sender_id, m.created_at as msg_created, s.username, s.avatar FROM shared_pins sp JOIN messages m ON sp.message_id=m.id JOIN users s ON m.sender_id=s.id WHERE sp.chat_user1=? AND sp.chat_user2=? ORDER BY sp.created_at DESC", [u1, u2]);
  res.json({ pinned: pinned });
});

app.get('/api/pinned/private/:fid', auth, async function(req, res) {
  const fid = parseInt(req.params.fid);
  const u1 = Math.min(req.userId, fid);
  const u2 = Math.max(req.userId, fid);
  const pinned = await dbAll("SELECT pp.*, m.message_text, m.file_name, m.file_type, m.file_path, m.sender_id, m.created_at as msg_created, s.username, s.avatar FROM private_pins pp JOIN messages m ON pp.message_id=m.id JOIN users s ON m.sender_id=s.id WHERE pp.chat_user1=? AND pp.chat_user2=? AND pp.pinned_by=? ORDER BY pp.created_at DESC", [u1, u2, req.userId]);
  res.json({ pinned: pinned });
});

app.get('/api/stickers/:packId', async function(req, res) {
  const packId = req.params.packId;
  const stickersDir = path.join(__dirname, 'public', 'stickers', packId);
  if (!fs.existsSync(stickersDir)) {
    return res.json({ stickers: [] });
  }
  try {
    const files = fs.readdirSync(stickersDir);
    const stickers = files.filter(function(f) {
      const ext = path.extname(f).toLowerCase();
      return ext === '.png' || ext === '.webp' || ext === '.gif' || ext === '.jpg' || ext === '.jpeg';
    });
    res.json({ stickers: stickers });
  } catch(e) {
    res.json({ stickers: [] });
  }
});

app.get('/api/unread', auth, async function(req, res) {
  res.json({ count: (await dbGet('SELECT COUNT(*) as c FROM messages WHERE receiver_id=? AND is_read=0 AND deleted_for_receiver=0', [req.userId]) || {}).c || 0 });
});

app.get('/api/users', auth, async function(req, res) {
  const users = await dbAll('SELECT id, username, email, avatar, is_temp, is_online, last_seen, is_typing FROM users WHERE id!=?', [req.userId]);
  res.json({ users: users });
});

app.get('/api/user', auth, async function(req, res) {
  res.json({ user: await dbGet('SELECT id, username, email, avatar, is_temp, is_online, last_seen FROM users WHERE id=?', [req.userId]) });
});

app.get('/api/health', async function(req, res) {
  try { await dbGet('SELECT 1 as ok'); res.json({ok:true, database:'postgres'}); }
  catch (e) { res.status(503).json({ok:false}); }
});

// ===== СТРАНИЦЫ =====
app.get('/', async function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login.html', async function(req, res) { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/register.html', async function(req, res) { res.sendFile(path.join(__dirname, 'public', 'register.html')); });
app.get('/dashboard.html', async function(req, res) { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });

// ===== ЗАПУСК =====
startDB().then(function() {
  app.listen(PORT, function() {
    console.log('🚀 Сервер запущен на port ' + PORT);
    if (storage.isConfigured) {
      console.log('📁 Cloudinary подключен: медиа хранятся вне Render');
    } else {
      console.error('❌ Cloudinary НЕ настроен — загрузка медиа отключена.');
    }
  });
}).catch(function(err) {
  console.error('❌ Не удалось запустить БД:', err);
  process.exit(1);
});

process.on('SIGTERM', async function() {
  await pool.end().catch(function(){});
  process.exit(0);
});
process.on('SIGINT', async function() {
  await pool.end().catch(function(){});
  process.exit(0);
});
