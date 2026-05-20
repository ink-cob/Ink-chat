const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const db = new Database('messenger.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id TEXT,
    user_id TEXT,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    sender_id TEXT,
    sender_name TEXT,
    text TEXT,
    file_url TEXT,
    file_name TEXT,
    file_type TEXT,
    timestamp TEXT,
    is_edited INTEGER DEFAULT 0
  );
`);

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Buffer.from(file.originalname, 'latin1').toString('utf8'))
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function generateUID() {
    let id = '';
    for (let i = 0; i < 10; i++) id += Math.floor(Math.random() * 10);
    const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    return exists ? generateUID() : id;
}

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const uid = generateUID();
        const createdAt = new Date().toLocaleString('ru-RU');
        
        db.prepare('INSERT INTO users (id, username, password, created_at) VALUES (?, ?, ?, ?)').run(uid, username, hashedPassword, createdAt);
        res.json({ id: uid, username, created_at: createdAt });
    } catch (err) {
        res.status(400).json({ error: 'Пользователь с таким никнеймом уже существует' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: 'Неверный никнейм или пароль' });
    }
    res.json({ id: user.id, username: user.username, created_at: user.created_at });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ fileUrl, fileName: req.file.originalname, fileType: req.file.mimetype });
});

io.on('connection', (socket) => {
    socket.on('user:join', (userId) => {
        socket.userId = userId;
        socket.join(userId);
        
        const userChats = db.prepare(`
            SELECT c.* FROM chats c 
            JOIN chat_members m ON c.id = m.chat_id 
            WHERE m.user_id = ?
        `).all(userId);
        
        userChats.forEach(chat => socket.join(chat.id));
        socket.emit('user:chats', userChats);
    });

    socket.on('profile:update', async ({ userId, newUsername, newPassword }) => {
        try {
            if (newUsername) {
                db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newUsername, userId);
            }
            if (newPassword) {
                const hashedPassword = await bcrypt.hash(newPassword, 10);
                db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, userId);
            }
            const updatedUser = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(userId);
            socket.emit('profile:updated', { success: true, user: updatedUser });
        } catch (err) {
            socket.emit('profile:updated', { success: false, error: 'Никнейм уже занят' });
        }
    });

    socket.on('profile:delete', (userId) => {
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        db.prepare('DELETE FROM chat_members WHERE user_id = ?').run(userId);
        socket.emit('profile:deleted', { success: true });
    });

    socket.on('chat:create_private', ({ userId, targetId }) => {
        const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
        if (!target) return socket.emit('chat:error', 'Пользователь с таким ID не найден');
        if (userId === targetId) return socket.emit('chat:error', 'Нельзя создать чат с самим собой');

        const exists = db.prepare(`
            SELECT chat_id FROM chat_members WHERE user_id = ? 
            INTERSECT 
            SELECT chat_id FROM chat_members WHERE user_id = ?
        `).get(userId, targetId);

        let chatId = exists ? exists.chat_id : null;

        if (!chatId) {
            chatId = 'chat_' + Date.now();
            db.prepare('INSERT INTO chats (id, name, is_group) VALUES (?, ?, 0)').run(chatId, target.username);
            db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?), (?, ?)').run(chatId, userId, chatId, targetId);
            io.to(targetId).emit('chat:new', { id: chatId, name: 'Чат с пользователем', is_group: 0 });
        }

        socket.join(chatId);
        const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC').all(chatId);
        socket.emit('chat:opened', { chatId, messages });
    });

    socket.on('chat:create_group', ({ userId, groupName }) => {
        const chatId = 'group_' + Date.now();
        db.prepare('INSERT INTO chats (id, name, is_group) VALUES (?, ?, 1)').run(chatId, groupName);
        db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(chatId, userId);
        
        socket.join(chatId);
        socket.emit('chat:new', { id: chatId, name: groupName, is_group: 1 });
        socket.emit('chat:opened', { chatId, messages: [] });
    });

    socket.on('message:send', (data) => {
        const { chatId, senderId, senderName, text, fileUrl, fileName, fileType } = data;
        const msgId = 'msg_' + Date.now() + Math.random().toString(36).substr(2, 5);
        const timestamp = new Date().toLocaleString('ru-RU');

        db.prepare(`
            INSERT INTO messages (id, chat_id, sender_id, sender_name, text, file_url, fileName, file_type, timestamp) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(msgId, chatId, senderId, senderName, text || null, fileUrl || null, fileName || null, fileType || null, timestamp);

        io.to(chatId).emit('message:new', { id: msgId, chatId, senderId, senderName, text, fileUrl, fileName, fileType, timestamp, is_edited: 0 });
    });

    socket.on('message:delete', ({ msgId, chatId }) => {
        db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
        io.to(chatId).emit('message:deleted', { msgId });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер мессенджера успешно запущен на порту ${PORT}`);
});

