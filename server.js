const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// База данных в оперативной памяти проекта Чат NK
const users = {}; 
const rooms = {}; 
const messages = {}; 
const blocks = {}; 

function generate10DigitId() {
    return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

io.on('connection', (socket) => {
    
    // Авторизация и создание профиля
    socket.on('register', ({ username, password }) => {
        const userId = generate10DigitId();
        const createdAt = new Date().toLocaleString('ru-RU');
        users[userId] = { id: userId, username, password, createdAt, socketId: socket.id, activeChats: [] };
        blocks[userId] = new Set();
        socket.emit('registerSuccess', { id: userId, username, createdAt });
    });

    socket.on('login', ({ id, password }) => {
        const user = users[id];
        if (user && user.password === password) {
            user.socketId = socket.id;
            if (!blocks[id]) blocks[id] = new Set();
            if (!user.activeChats) user.activeChats = [];
            socket.emit('loginSuccess', { id: user.id, username: user.username, createdAt: user.createdAt });
            socket.emit('updateChatsList', getUserChatsData(id));
            sendBlockedList(socket, id);
        } else {
            socket.emit('errorMsg', 'Неверный ID или пароль!');
        }
    });

    // Поиск пользователя
    socket.on('searchUser', (searchId) => {
        const found = users[searchId];
        if (found) socket.emit('searchResult', { id: found.id, username: found.username });
        else socket.emit('searchResult', null);
    });

    // ОБОЮДНОЕ СОЗДАНИЕ И ВХОД В ЧАТ
    socket.on('joinRoom', ({ currentUserId, targetIds, roomName, isGroup }) => {
        let roomId;
        if (!isGroup) {
            // Личный чат строго по двум ID (всегда одинаковый для этой пары людей)
            roomId = [currentUserId, targetIds].sort().join('_');
        } else {
            // Группа по ее имени или случайному ключу
            roomId = roomName.startsWith('group_') ? roomName : 'group_' + Math.random().toString(36).substr(2, 9);
        }

        socket.join(roomId);

        // Если такой беседы еще нет — создаем ее
        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                name: isGroup ? roomName : (users[targetIds] ? users[targetIds].username : 'Личный чат'),
                participants: isGroup ? [currentUserId, ...targetIds] : [currentUserId, targetIds],
                isGroup: isGroup
            };
        }

        // Автоматически добавляем и закрепляем этот чат ОБОИМ участникам в список
        rooms[roomId].participants.forEach(pId => {
            if (users[pId]) {
                if (!users[pId].activeChats) users[pId].activeChats = [];
                if (!users[pId].activeChats.includes(roomId)) {
                    users[pId].activeChats.push(roomId);
                }
                // Мгновенно обновляем список диалогов у тех, кто онлайн
                if (users[pId].socketId) {
                    io.to(users[pId].socketId).emit('updateChatsList', getUserChatsData(pId));
                }
            }
        });

        // Название чата для конкретного пользователя
        let displayName = rooms[roomId].name;
        if (!isGroup) {
            const partnerId = rooms[roomId].participants.find(id => id !== currentUserId);
            if (users[partnerId]) displayName = users[partnerId].username;
        }

        socket.emit('roomJoined', { roomId, roomName: displayName, messages: messages[roomId] || [] });
    });

    // Отправка сообщений
    socket.on('sendMessage', ({ roomId, senderId, text, file }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (!room.isGroup) {
            const recipientId = room.participants.find(pId => pId !== senderId);
            if (blocks[recipientId] && blocks[recipientId].has(senderId)) {
                return socket.emit('errorMsg', 'Вы заблокированы этим пользователем.');
            }
        }

        const msgId = 'msg_' + Math.random().toString(36).substr(2, 9);
        const newMsg = {
            id: msgId,
            senderId,
            senderName: users[senderId] ? users[senderId].username : 'Удален',
            text,
            file,
            time: new Date().toLocaleTimeString('ru-RU').slice(0, 5),
            status: 'Отправлено'
        };

        if (!messages[roomId]) messages[roomId] = [];
        messages[roomId].push(newMsg);

        io.to(roomId).emit('newMessage', { roomId, message: newMsg });
    });

    // Редактирование и удаление текстов
    socket.on('deleteMessage', ({ roomId, msgId }) => {
        if (messages[roomId]) {
            messages[roomId] = messages[roomId].filter(m => m.id !== msgId);
            io.to(roomId).emit('messageDeleted', msgId);
        }
    });

    socket.on('editMessage', ({ roomId, msgId, newText }) => {
        if (messages[roomId]) {
            const msg = messages[roomId].find(m => m.id === msgId);
            if (msg) {
                msg.text = newText;
                msg.status = 'Изменено';
                io.to(roomId).emit('messageEdited', { msgId, newText });
            }
        }
    });

    // Настройки профиля
    socket.on('updateProfile', ({ id, newUsername, newPassword }) => {
        if (users[id]) {
            if (newUsername) users[id].username = newUsername;
            if (newPassword) users[id].password = newPassword;
            socket.emit('profileUpdated', { username: users[id].username });
        }
    });

    socket.on('deleteAccount', (id) => {
        if (users[id]) { delete users[id]; delete blocks[id]; socket.emit('accountDeleted'); }
    });

    // Блокировки
    socket.on('blockUser', ({ currentUserId, targetId }) => {
        if (blocks[currentUserId]) { blocks[currentUserId].add(targetId); sendBlockedList(socket, currentUserId); }
    });

    socket.on('unblockUser', ({ currentUserId, targetId }) => {
        if (blocks[currentUserId] && blocks[currentUserId].has(targetId)) { blocks[currentUserId].delete(targetId); sendBlockedList(socket, currentUserId); }
    });

    socket.on('getBlockedUsers', (uid) => sendBlockedList(socket, uid));

    // Функции-вспомогатели
    function getUserChatsData(userId) {
        const u = users[userId];
        if (!u || !u.activeChats) return [];
        return u.activeChats.map(rId => {
            const r = rooms[rId];
            let name = r ? r.name : 'Диалог';
            if (r && !r.isGroup) {
                const pId = r.participants.find(id => id !== userId);
                if (users[pId]) name = users[pId].username;
            }
            return { id: rId, name, isGroup: r ? r.isGroup : false };
        });
    }

    function sendBlockedList(targetSocket, userId) {
        const list = Array.from(blocks[userId] || []).map(bId => ({ id: bId, username: users[bId] ? users[bId].username : 'Пользователь' }));
        targetSocket.emit('blockedUsersList', list);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен`);
});
