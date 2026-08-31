const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// ===== КОНФИГУРАЦИЯ CLOUDINARY (ЯВНАЯ ПЕРЕДАЧА ДАННЫХ) =====
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'c-7d73214cf2f22182d62d9c78dd9899';
const API_KEY = process.env.CLOUDINARY_API_KEY || '316721723778863';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '6UojYlIQ82k428il5LtgAoNSBGk';

cloudinary.config({
    cloud_name: CLOUD_NAME.trim(), // Удаляем возможные пробелы
    api_key: API_KEY.trim(),
    api_secret: API_SECRET.trim()
});

console.log('✅ Cloudinary настроен');
console.log('📦 Cloud Name:', cloudinary.config().cloud_name);
console.log('🔑 API Key:', cloudinary.config().api_key ? '✅ Задан' : '❌ Отсутствует');

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ =====
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Проверка подключения к БД
pool.connect()
    .then(() => console.log('✅ PostgreSQL DB OK'))
    .catch(err => console.error('❌ Ошибка подключения к БД:', err));

// ===== НАСТРОЙКА MULTER С CLOUDINARY =====
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'vero_messenger',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'ogg', 'mp3', 'pdf', 'doc', 'docx'],
        resource_type: 'auto'
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100 MB
});

// ===== ИНИЦИАЛИЗАЦИЯ EXPRESS =====
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ===== СОЗДАНИЕ ТАБЛИЦ =====
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                avatar_url TEXT,
                is_online BOOLEAN DEFAULT FALSE,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                content TEXT,
                media_url TEXT,
                media_kind VARCHAR(50),
                duration_seconds INTEGER,
                file_size INTEGER,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, friend_id)
            )
        `);

        console.log('✅ Таблицы созданы/проверены');
    } catch (error) {
        console.error('❌ Ошибка инициализации БД:', error);
    }
}

initDatabase();

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
function generateToken(userId) {
    return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// ===== МАРШРУТЫ АУТЕНТИФИКАЦИИ =====
// Регистрация
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Все поля обязательны' });
        }

        const existingUser = await pool.query(
            'SELECT * FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
            [username, email, hashedPassword]
        );

        const user = result.rows[0];
        const token = generateToken(user.id);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: error.message });
    }
});

// Вход
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Все поля обязательны' });
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        await pool.query(
            'UPDATE users SET is_online = TRUE, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
            [user.id]
        );

        const token = generateToken(user.id);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar_url: user.avatar_url
            }
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: error.message });
    }
});

// Выход
app.post('/api/logout', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            await pool.query(
                'UPDATE users SET is_online = FALSE, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
                [decoded.id]
            );
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка выхода:', error);
        res.json({ success: true });
    }
});

// ===== МАРШРУТЫ ЗАГРУЗКИ ФАЙЛОВ (С CLOUDINARY) =====

// Загрузка аватарки
app.post('/api/upload-avatar', upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        const avatarUrl = req.file.path || req.file.secure_url;

        await pool.query(
            'UPDATE users SET avatar_url = $1 WHERE id = $2',
            [avatarUrl, userId]
        );

        res.json({
            success: true,
            avatar_url: avatarUrl,
            message: 'Аватарка обновлена'
        });
    } catch (error) {
        console.error('❌ Ошибка загрузки аватарки:', error);
        res.status(500).json({ error: error.message });
    }
});

// Загрузка файла для сообщения
app.post('/api/upload-message-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        const fileUrl = req.file.path || req.file.secure_url;
        const mimeType = req.file.mimetype;

        let mediaKind = 'file';
        if (mimeType.startsWith('image/')) mediaKind = 'image';
        else if (mimeType.startsWith('video/')) mediaKind = 'video';
        else if (mimeType.startsWith('audio/')) mediaKind = 'audio';

        // Получаем длительность для видео/аудио (если есть)
        let durationSeconds = null;
        if (req.body.duration) {
            durationSeconds = parseInt(req.body.duration);
        }

        res.json({
            success: true,
            url: fileUrl,
            public_id: req.file.filename,
            mediaKind: mediaKind,
            durationSeconds: durationSeconds,
            fileSize: req.file.size,
            message: 'Файл загружен в Cloudinary'
        });
    } catch (error) {
        console.error('❌ Ошибка загрузки файла:', error);
        res.status(500).json({ error: error.message });
    }
});

// Универсальная загрузка (для совместимости)
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        const fileUrl = req.file.path || req.file.secure_url;
        const mimeType = req.file.mimetype;

        let mediaKind = 'file';
        if (mimeType.startsWith('image/')) mediaKind = 'image';
        else if (mimeType.startsWith('video/')) mediaKind = 'video';
        else if (mimeType.startsWith('audio/')) mediaKind = 'audio';

        res.json({
            success: true,
            url: fileUrl,
            public_id: req.file.filename,
            mediaKind: mediaKind,
            fileSize: req.file.size
        });
    } catch (error) {
        console.error('❌ Ошибка загрузки:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== МАРШРУТЫ ПОЛЬЗОВАТЕЛЕЙ =====
app.get('/api/users', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const currentUserId = decoded.id;

        const result = await pool.query(
            'SELECT id, username, email, avatar_url, is_online, last_seen FROM users WHERE id != $1',
            [currentUserId]
        );

        res.json({
            success: true,
            users: result.rows
        });
    } catch (error) {
        console.error('Ошибка получения пользователей:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const result = await pool.query(
            'SELECT id, username, email, avatar_url, is_online, last_seen FROM users WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Ошибка получения пользователя:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== МАРШРУТЫ ДРУЗЕЙ =====
app.post('/api/friends/request', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        const { friendId } = req.body;

        if (userId === friendId) {
            return res.status(400).json({ error: 'Нельзя добавить себя' });
        }

        const existing = await pool.query(
            'SELECT * FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
            [userId, friendId]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Запрос уже отправлен' });
        }

        await pool.query(
            'INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, $3)',
            [userId, friendId, 'pending']
        );

        res.json({ success: true, message: 'Запрос отправлен' });
    } catch (error) {
        console.error('Ошибка отправки запроса:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/accept', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        const { friendId } = req.body;

        await pool.query(
            'UPDATE friends SET status = $1 WHERE user_id = $2 AND friend_id = $3',
            ['accepted', friendId, userId]
        );

        res.json({ success: true, message: 'Запрос принят' });
    } catch (error) {
        console.error('Ошибка принятия запроса:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/friends', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        const result = await pool.query(
            `SELECT u.id, u.username, u.email, u.avatar_url, u.is_online, f.status
             FROM friends f
             JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
             WHERE (f.user_id = $1 OR f.friend_id = $1)
               AND u.id != $1
               AND f.status = 'accepted'`,
            [userId]
        );

        res.json({
            success: true,
            friends: result.rows
        });
    } catch (error) {
        console.error('Ошибка получения друзей:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== МАРШРУТЫ СООБЩЕНИЙ =====
app.get('/api/messages/:userId', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const currentUserId = decoded.id;
        const otherUserId = parseInt(req.params.userId);

        const result = await pool.query(
            `SELECT m.*, u.username, u.avatar_url
             FROM messages m
             JOIN users u ON u.id = m.sender_id
             WHERE (sender_id = $1 AND receiver_id = $2)
                OR (sender_id = $2 AND receiver_id = $1)
             ORDER BY created_at ASC`,
            [currentUserId, otherUserId]
        );

        // Отметить сообщения как прочитанные
        await pool.query(
            'UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2',
            [otherUserId, currentUserId]
        );

        res.json({
            success: true,
            messages: result.rows
        });
    } catch (error) {
        console.error('Ошибка получения сообщений:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/messages', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const senderId = decoded.id;
        const { receiverId, content, mediaUrl, mediaKind, durationSeconds, fileSize } = req.body;

        if (!receiverId) {
            return res.status(400).json({ error: 'Получатель не указан' });
        }

        if (!content && !mediaUrl) {
            return res.status(400).json({ error: 'Нет содержимого сообщения' });
        }

        const result = await pool.query(
            `INSERT INTO messages (sender_id, receiver_id, content, media_url, media_kind, duration_seconds, file_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [senderId, receiverId, content, mediaUrl, mediaKind, durationSeconds, fileSize]
        );

        const message = result.rows[0];

        // Отправить через Socket.IO
        io.to(`user_${receiverId}`).emit('new_message', {
            ...message,
            sender: { id: senderId }
        });

        res.json({
            success: true,
            message: message
        });
    } catch (error) {
        console.error('Ошибка отправки сообщения:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== МАРШРУТ ДЛЯ ПРОВЕРКИ ЗДОРОВЬЯ =====
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== ОБРАБОТКА СТАТИЧЕСКИХ ФАЙЛОВ =====
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== СОКЕТЫ =====
io.on('connection', (socket) => {
    console.log('🟢 Новое подключение:', socket.id);

    socket.on('user_online', async (userId) => {
        try {
            await pool.query(
                'UPDATE users SET is_online = TRUE, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
                [userId]
            );
            socket.join(`user_${userId}`);
            socket.userId = userId;
            io.emit('user_status', { userId, isOnline: true });
        } catch (error) {
            console.error('Ошибка online:', error);
        }
    });

    socket.on('typing', (data) => {
        io.to(`user_${data.receiverId}`).emit('typing', {
            userId: socket.userId,
            isTyping: data.isTyping
        });
    });

    socket.on('message_read', async (data) => {
        try {
            await pool.query(
                'UPDATE messages SET is_read = TRUE WHERE id = $1',
                [data.messageId]
            );
            io.to(`user_${data.senderId}`).emit('message_read', {
                messageId: data.messageId
            });
        } catch (error) {
            console.error('Ошибка отметки прочитанного:', error);
        }
    });

    socket.on('disconnect', async () => {
        if (socket.userId) {
            try {
                await pool.query(
                    'UPDATE users SET is_online = FALSE, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
                    [socket.userId]
                );
                io.emit('user_status', { userId: socket.userId, isOnline: false });
            } catch (error) {
                console.error('Ошибка offline:', error);
            }
        }
        console.log('🔴 Отключение:', socket.id);
    });
});

// ===== ЗАПУСК СЕРВЕРА =====
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порт ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
});