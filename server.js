const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 10e6 // Suporte para envio de fotos até 10MB em base64
});

app.use(express.static(path.join(__dirname, 'public')));

// Chave secreta do Dono / Super Admin
const OWNER_PASSCODE = "dono123"; 

// Base de Dados em memória
// registeredUsers: { "username_lowercased": { username, password, avatar, friends: [], requests: [], isGlobalBanned: false } }
const registeredUsers = {}; 
const activeSockets = {};   // { socketId: { username, avatar, isOwner, activeTarget: { type, id }, spamTracker } }

const rooms = {
  'Geral': {
    name: 'Geral',
    isPrivate: false,
    password: null,
    creatorUsername: 'Sistema',
    admins: ['Sistema'],
    muted: {}, // { username: timestampUntil }
    banned: []
  }
};

const roomStore = { 'Geral': [] }; 
const dmStore = {};   // { dmKey: [ { sender, avatar, text, image, time } ] }

function getDmKey(user1, user2) {
  return [user1.toLowerCase(), user2.toLowerCase()].sort().join('_DM_');
}

function getSocketByUsername(username) {
  if (!username) return null;
  for (const [sId, data] of Object.entries(activeSockets)) {
    if (data.username.toLowerCase() === username.toLowerCase()) {
      return io.sockets.sockets.get(sId);
    }
  }
  return null;
}

function isUserOnline(username) {
  if (!username) return false;
  return Object.values(activeSockets).some(u => u.username.toLowerCase() === username.toLowerCase());
}

function isRoomAdmin(username, roomName) {
  const room = rooms[roomName];
  if (!room) return false;
  if (room.creatorUsername.toLowerCase() === username.toLowerCase()) return true;
  return room.admins.some(a => a.toLowerCase() === username.toLowerCase());
}

function getRoomUsersList(roomName) {
  const list = [];
  const room = rooms[roomName];
  for (const [sId, u] of Object.entries(activeSockets)) {
    if (u.activeTarget && u.activeTarget.type === 'room' && u.activeTarget.id === roomName) {
      const isAdmin = isRoomAdmin(u.username, roomName);
      const isMuted = room && room.muted[u.username] && room.muted[u.username] > Date.now();
      list.push({
        socketId: sId,
        username: u.username,
        avatar: u.avatar,
        isAdmin,
        isMuted: !!isMuted,
        isOwner: u.isOwner
      });
    }
  }
  return list;
}

function getPublicRoomsList() {
  return Object.values(rooms).map(r => ({
    name: r.name,
    isPrivate: r.isPrivate,
    creatorUsername: r.creatorUsername
  }));
}

function getUserFriendsList(username) {
  const uKey = username.toLowerCase();
  const uData = registeredUsers[uKey];
  if (!uData) return [];
  return uData.friends.map(fName => {
    const fData = registeredUsers[fName.toLowerCase()];
    return {
      username: fName,
      avatar: fData ? fData.avatar : '👤',
      online: isUserOnline(fName)
    };
  });
}

// Atualização em tempo real para o Painel do Dono (Super Admin)
function sendOwnerGlobalUpdate() {
  const allUsers = Object.values(registeredUsers).map(u => ({
    username: u.username,
    online: isUserOnline(u.username),
    avatar: u.avatar,
    isBanned: u.isGlobalBanned || false
  }));

  const allDMs = [];
  for (const [key, msgs] of Object.entries(dmStore)) {
    const parts = key.split('_DM_');
    allDMs.push({
      key,
      user1: parts[0],
      user2: parts[1],
      msgCount: msgs.length,
      history: msgs
    });
  }

  const allRooms = Object.values(rooms).map(r => ({
    name: r.name,
    isPrivate: r.isPrivate,
    creator: r.creatorUsername,
    history: roomStore[r.name] || []
  }));

  for (const [sId, uData] of Object.entries(activeSockets)) {
    if (uData.isOwner) {
      const sock = io.sockets.sockets.get(sId);
      if (sock) {
        sock.emit('ownerDashboardData', {
          users: allUsers,
          rooms: allRooms,
          dms: allDMs
        });
      }
    }
  }
}

io.on('connection', (socket) => {

  // --- SISTEMA DE REGISTO E LOGIN COM NOME E PALAVRA-PASSE ---
  socket.on('register', (data, callback) => {
    const username = (data.username || '').trim();
    const password = (data.password || '').trim();
    const avatar = data.avatar || '👤';

    if (!username || !password) {
      return callback({ success: false, message: 'Preencha o nome de utilizador e a palavra-passe!' });
    }

    const uKey = username.toLowerCase();
    if (registeredUsers[uKey]) {
      return callback({ success: false, message: 'Este nome de utilizador já está registado!' });
    }

    registeredUsers[uKey] = {
      username,
      password,
      avatar,
      friends: [],
      requests: [],
      isGlobalBanned: false
    };

    callback({ success: true, message: 'Conta criada com sucesso! Faça login.' });
    sendOwnerGlobalUpdate();
  });

  socket.on('login', (data, callback) => {
    const username = (data.username || '').trim();
    const password = (data.password || '').trim();
    const ownerCode = (data.ownerCode || '').trim();

    const uKey = username.toLowerCase();
    const user = registeredUsers[uKey];

    if (!user) {
      return callback({ success: false, message: 'Utilizador não encontrado! Crie uma conta primeiro.' });
    }

    if (user.password !== password) {
      return callback({ success: false, message: 'Palavra-passe incorreta!' });
    }

    if (user.isGlobalBanned) {
      return callback({ success: false, message: 'Esta conta foi BANIDA GLOBALMENTE pelo Dono!' });
    }

    const isOwner = (ownerCode === OWNER_PASSCODE);

    activeSockets[socket.id] = {
      username: user.username,
      avatar: user.avatar,
      isOwner,
      activeTarget: { type: 'room', id: 'Geral' },
      spamTracker: { text: '', count: 0 }
    };

    socket.join('room_Geral');

    callback({
      success: true,
      username: user.username,
      avatar: user.avatar,
      isOwner,
      rooms: getPublicRoomsList(),
      friends: getUserFriendsList(user.username),
      requests: user.requests,
      history: roomStore['Geral'] || []
    });

    io.to('room_Geral').emit('updateUsers', getRoomUsersList('Geral'));
    sendOwnerGlobalUpdate();
  });

  // --- MENSAGENS E ENVIO DE FOTOS ---
  socket.on('chatMessage', (data) => {
    const user = activeSockets[socket.id];
    if (!user || (!data.text && !data.image)) return;

    const rawText = (data.text || '').trim();
    const imageData = data.image || null;

    // --- SISTEMA ANTI-SPAM (Mute automático de 1 minuto) ---
    const spamCheckKey = imageData ? '[foto]' : rawText.toLowerCase();
    if (!user.isOwner) {
      if (user.spamTracker.text === spamCheckKey && spamCheckKey !== '') {
        user.spamTracker.count++;
      } else {
        user.spamTracker.text = spamCheckKey;
        user.spamTracker.count = 1;
      }

      if (user.spamTracker.count >= 3 && user.activeTarget.type === 'room') {
        const roomName = user.activeTarget.id;
        if (rooms[roomName]) {
          rooms[roomName].muted[user.username] = Date.now() + (60 * 1000); // 1 minuto de mute
          socket.emit('errorMsg', 'Foste silenciado por 1 minuto por fazer SPAM!');
          user.spamTracker.count = 0;
          io.to('room_' + roomName).emit('updateUsers', getRoomUsersList(roomName));
          return;
        }
      }
    }

    const messageData = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      senderId: socket.id,
      user: user.username,
      avatar: user.avatar,
      text: rawText,
      image: imageData, // Foto em base64
      isAdmin: user.isOwner || (user.activeTarget.type === 'room' && isRoomAdmin(user.username, user.activeTarget.id)),
      isOwner: user.isOwner,
      isSystem: false,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (user.activeTarget.type === 'room') {
      const roomName = user.activeTarget.id;
      const room = rooms[roomName];

      if (!user.isOwner && room && room.muted[user.username] && room.muted[user.username] > Date.now()) {
        const remaining = Math.ceil((room.muted[user.username] - Date.now()) / 1000);
        return socket.emit('errorMsg', `Estás silenciado neste grupo durante mais ${remaining} segundo(s)!`);
      }

      if (!roomStore[roomName]) roomStore[roomName] = [];
      roomStore[roomName].push(messageData);

      io.to('room_' + roomName).emit('message', messageData);

    } else if (user.activeTarget.type === 'dm') {
      const dmKey = user.activeTarget.id;

      if (!dmStore[dmKey]) dmStore[dmKey] = [];
      dmStore[dmKey].push(messageData);

      io.to('dm_' + dmKey).emit('message', messageData);

      const targetUsername = user.activeTarget.withUser;
      const targetSocket = getSocketByUsername(targetUsername);
      if (targetSocket) {
        targetSocket.emit('unreadDMNotification', { from: user.username, text: rawText || '📷 Enviou uma foto' });
      }
    }

    // Notifica o painel admin em tempo real
    sendOwnerGlobalUpdate();
  });

  // Troca de Salas e DMs
  socket.on('openDM', (targetUsername) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser) return;

    const sender = currentUser.username;
    const dmKey = getDmKey(sender, targetUsername);

    if (currentUser.activeTarget.type === 'room') {
      socket.leave('room_' + currentUser.activeTarget.id);
      io.to('room_' + currentUser.activeTarget.id).emit('updateUsers', getRoomUsersList(currentUser.activeTarget.id));
    } else if (currentUser.activeTarget.type === 'dm') {
      socket.leave('dm_' + currentUser.activeTarget.id);
    }

    currentUser.activeTarget = { type: 'dm', id: dmKey, withUser: targetUsername };
    socket.join('dm_' + dmKey);

    const history = dmStore[dmKey] || [];
    const targetUserObj = registeredUsers[targetUsername.toLowerCase()];

    socket.emit('dmOpened', {
      withUser: targetUsername,
      avatar: targetUserObj ? targetUserObj.avatar : '👤',
      online: isUserOnline(targetUsername),
      history
    });
  });

  socket.on('switchRoom', (data) => {
    const targetRoom = data.roomName;
    const currentUser = activeSockets[socket.id];
    if (!currentUser || !rooms[targetRoom]) return;

    if (currentUser.activeTarget.type === 'room') {
      socket.leave('room_' + currentUser.activeTarget.id);
      io.to('room_' + currentUser.activeTarget.id).emit('updateUsers', getRoomUsersList(currentUser.activeTarget.id));
    } else if (currentUser.activeTarget.type === 'dm') {
      socket.leave('dm_' + currentUser.activeTarget.id);
    }

    currentUser.activeTarget = { type: 'room', id: targetRoom };
    socket.join('room_' + targetRoom);

    socket.emit('roomSwitched', {
      roomName: targetRoom,
      isAdmin: currentUser.isOwner || isRoomAdmin(currentUser.username, targetRoom),
      creatorUsername: rooms[targetRoom].creatorUsername,
      history: roomStore[targetRoom] || []
    });

    io.to('room_' + targetRoom).emit('updateUsers', getRoomUsersList(targetRoom));
  });

  // Ação de Banimento do Dono
  socket.on('ownerAction', (data) => {
    const user = activeSockets[socket.id];
    if (!user || !user.isOwner) return socket.emit('errorMsg', 'Apenas o Dono do Talkon pode fazer isto!');

    if (data.action === 'globalBan') {
      const uKey = data.target.toLowerCase();
      if (registeredUsers[uKey]) {
        registeredUsers[uKey].isGlobalBanned = true;
      }
      const targetSocket = getSocketByUsername(data.target);
      if (targetSocket) {
        targetSocket.emit('errorMsg', 'Foste BANIDO GLOBALMENTE do Talkon pelo Dono!');
        targetSocket.disconnect(true);
      }
      socket.emit('successMsg', `Utilizador @${data.target} foi banido globalmente!`);
    }
    sendOwnerGlobalUpdate();
  });

  socket.on('disconnect', () => {
    const user = activeSockets[socket.id];
    if (user) {
      delete activeSockets[socket.id];
      if (user.activeTarget.type === 'room') {
        io.to('room_' + user.activeTarget.id).emit('updateUsers', getRoomUsersList(user.activeTarget.id));
      }
      sendOwnerGlobalUpdate();
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Talkon v6.0 Master] Servidor a correr em http://localhost:${PORT}`);
});