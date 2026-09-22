const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Persistência em memória durante a sessão
const registeredUsers = {}; // { username: { username, avatar, friends: [], requests: [] } }
const activeSockets = {};   // { socketId: { username, avatar, activeTarget: { type, id, withUser } } }

// rooms: { roomName: { name, isPrivate, password, creatorUsername, admins: [], muted: { username: timestamp }, banned: [] } }
const rooms = {
  'Geral': {
    name: 'Geral',
    isPrivate: false,
    password: null,
    creatorUsername: 'Sistema',
    admins: ['Sistema'],
    muted: {},
    banned: []
  }
};

const roomStore = {}; // { roomName: [ messages ] }
const dmStore = {};   // { dmKey: [ messages ] }

function getDmKey(user1, user2) {
  return [user1, user2].sort().join('_DM_');
}

function getSocketByUsername(username) {
  for (const [sId, data] of Object.entries(activeSockets)) {
    if (data.username.toLowerCase() === username.toLowerCase()) {
      return io.sockets.sockets.get(sId);
    }
  }
  return null;
}

function isUserOnline(username) {
  return Object.values(activeSockets).some(u => u.username.toLowerCase() === username.toLowerCase());
}

function isRoomAdmin(username, roomName) {
  const room = rooms[roomName];
  if (!room) return false;
  if (room.creatorUsername.toLowerCase() === username.toLowerCase()) return true;
  if (room.admins.some(a => a.toLowerCase() === username.toLowerCase())) return true;
  // Se for a sala Geral e não houver admins ativos além de Sistema, o criador/primeiro a entrar ganha privilégios
  return false;
}

function getUserFriendsList(username) {
  const uData = registeredUsers[username];
  if (!uData) return [];
  return uData.friends.map(fName => {
    const fData = registeredUsers[fName];
    return {
      username: fName,
      avatar: fData ? fData.avatar : '👤',
      online: isUserOnline(fName)
    };
  });
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
        isMuted
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

function notifyFriendsStatusChange(username) {
  const user = registeredUsers[username];
  if (user && user.friends) {
    user.friends.forEach(friendName => {
      const friendSocket = getSocketByUsername(friendName);
      if (friendSocket) {
        friendSocket.emit('friendsListUpdate', getUserFriendsList(friendName));
      }
    });
  }
}

io.on('connection', (socket) => {

  // Entrar no Talkon
  socket.on('join', (data) => {
    const username = (data.username || 'Anónimo').trim();
    const avatar = data.avatar || '👤';

    if (!registeredUsers[username]) {
      registeredUsers[username] = {
        username,
        avatar,
        friends: [],
        requests: []
      };
    } else {
      registeredUsers[username].avatar = avatar;
    }

    activeSockets[socket.id] = {
      username,
      avatar,
      activeTarget: { type: 'room', id: 'Geral' }
    };

    socket.join('room_Geral');

    // Notifica na sala Geral
    io.to('room_Geral').emit('message', {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      user: 'Sistema',
      avatar: '⚙️',
      text: `${username} entrou no Talkon.`,
      isSystem: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    notifyFriendsStatusChange(username);

    // Envia dados iniciais
    socket.emit('initData', {
      username,
      avatar,
      rooms: getPublicRoomsList(),
      friends: getUserFriendsList(username),
      requests: registeredUsers[username].requests,
      history: roomStore['Geral'] || []
    });

    io.to('room_Geral').emit('updateUsers', getRoomUsersList('Geral'));
  });

  // Pedidos de Amizade
  socket.on('sendFriendRequest', (targetUsername) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser) return;

    const sender = currentUser.username;
    const target = (targetUsername || '').trim();

    if (target.toLowerCase() === sender.toLowerCase()) {
      return socket.emit('errorMsg', 'Não podes enviar pedido de amizade a ti próprio!');
    }

    const targetData = registeredUsers[target];
    if (!targetData) {
      return socket.emit('errorMsg', `Utilizador "${target}" não encontrado!`);
    }

    const senderData = registeredUsers[sender];
    if (senderData.friends.includes(target)) {
      return socket.emit('errorMsg', `Já és amigo de "${target}"!`);
    }

    if (targetData.requests.includes(sender)) {
      return socket.emit('errorMsg', `Já enviaste um pedido para "${target}"!`);
    }

    targetData.requests.push(sender);
    socket.emit('successMsg', `Pedido de amizade enviado para ${target}!`);

    const targetSocket = getSocketByUsername(target);
    if (targetSocket) {
      targetSocket.emit('incomingFriendRequest', {
        from: sender,
        requests: targetData.requests
      });
    }
  });

  socket.on('respondFriendRequest', (data) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser) return;

    const myName = currentUser.username;
    const targetName = data.from;
    const accept = data.accept;

    const myData = registeredUsers[myName];
    const targetData = registeredUsers[targetName];

    if (!myData) return;

    myData.requests = myData.requests.filter(r => r !== targetName);

    if (accept && targetData) {
      if (!myData.friends.includes(targetName)) myData.friends.push(targetName);
      if (!targetData.friends.includes(myName)) targetData.friends.push(myName);

      socket.emit('successMsg', `Agora és amigo de ${targetName}!`);
      
      const targetSocket = getSocketByUsername(targetName);
      if (targetSocket) {
        targetSocket.emit('successMsg', `${myName} aceitou o teu pedido de amizade!`);
        targetSocket.emit('friendsListUpdate', getUserFriendsList(targetName));
      }
    }

    socket.emit('friendsListUpdate', getUserFriendsList(myName));
    socket.emit('requestsUpdate', myData.requests);
  });

  // Abrir DM
  socket.on('openDM', (targetUsername) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser) return;

    const sender = currentUser.username;
    const dmKey = getDmKey(sender, targetUsername);

    if (currentUser.activeTarget.type === 'room') {
      const oldRoom = currentUser.activeTarget.id;
      socket.leave('room_' + oldRoom);
      io.to('room_' + oldRoom).emit('updateUsers', getRoomUsersList(oldRoom));
    } else if (currentUser.activeTarget.type === 'dm') {
      socket.leave('dm_' + currentUser.activeTarget.id);
    }

    currentUser.activeTarget = { type: 'dm', id: dmKey, withUser: targetUsername };
    socket.join('dm_' + dmKey);

    const history = dmStore[dmKey] || [];
    const targetUserObj = registeredUsers[targetUsername];

    socket.emit('dmOpened', {
      withUser: targetUsername,
      avatar: targetUserObj ? targetUserObj.avatar : '👤',
      online: isUserOnline(targetUsername),
      history
    });
  });

  // Criar Grupo
  socket.on('createRoom', (data) => {
    const roomName = (data.name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    const password = data.password ? data.password.trim() : null;
    const isPrivate = data.isPrivate || false;
    const currentUser = activeSockets[socket.id];

    if (!roomName) return socket.emit('errorMsg', 'Nome de grupo inválido!');
    if (rooms[roomName]) return socket.emit('errorMsg', 'Já existe um grupo com esse nome!');

    const creator = currentUser ? currentUser.username : 'Anónimo';

    rooms[roomName] = {
      name: roomName,
      isPrivate: isPrivate,
      password: password,
      creatorUsername: creator,
      admins: [creator],
      muted: {},
      banned: []
    };

    io.emit('roomsList', getPublicRoomsList());
    socket.emit('roomCreated', { name: roomName, password });
  });

  // Trocar/Entrar no Grupo
  socket.on('switchRoom', (data) => {
    const targetRoom = data.roomName;
    const inputPassword = data.password || '';
    const currentUser = activeSockets[socket.id];

    if (!rooms[targetRoom]) return socket.emit('errorMsg', 'Grupo não encontrado!');
    const room = rooms[targetRoom];

    if (!currentUser) return;

    // Verificar se está banido do grupo
    if (room.banned.includes(currentUser.username)) {
      return socket.emit('errorMsg', `Foste banido do grupo #${targetRoom}! Não podes entrar.`);
    }

    // Verificar palavra-passe
    if (room.isPrivate && room.password && room.password !== inputPassword) {
      return socket.emit('errorMsg', 'Palavra-passe incorreta para este grupo!');
    }

    // Sair da localização anterior
    if (currentUser.activeTarget.type === 'room') {
      const oldRoom = currentUser.activeTarget.id;
      socket.leave('room_' + oldRoom);
      io.to('room_' + oldRoom).emit('message', {
        id: Date.now() + Math.random().toString(36).substring(2, 7),
        user: 'Sistema',
        avatar: '⚙️',
        text: `${currentUser.username} saiu do grupo.`,
        isSystem: true,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
      io.to('room_' + oldRoom).emit('updateUsers', getRoomUsersList(oldRoom));
    } else if (currentUser.activeTarget.type === 'dm') {
      socket.leave('dm_' + currentUser.activeTarget.id);
    }

    currentUser.activeTarget = { type: 'room', id: targetRoom };
    socket.join('room_' + targetRoom);

    const history = roomStore[targetRoom] || [];

    socket.emit('roomSwitched', {
      roomName: targetRoom,
      isAdmin: isRoomAdmin(currentUser.username, targetRoom),
      creatorUsername: room.creatorUsername,
      bannedList: isRoomAdmin(currentUser.username, targetRoom) ? room.banned : [],
      history
    });

    io.to('room_' + targetRoom).emit('message', {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      user: 'Sistema',
      avatar: '⚙️',
      text: `${currentUser.username} entrou no grupo #${targetRoom}.`,
      isSystem: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    io.to('room_' + targetRoom).emit('updateUsers', getRoomUsersList(targetRoom));
  });

  // Digitação
  socket.on('typing', () => {
    const user = activeSockets[socket.id];
    if (user) {
      if (user.activeTarget.type === 'room') {
        socket.to('room_' + user.activeTarget.id).emit('userTyping', { id: socket.id, user: user.username, avatar: user.avatar });
      } else if (user.activeTarget.type === 'dm') {
        socket.to('dm_' + user.activeTarget.id).emit('userTyping', { id: socket.id, user: user.username, avatar: user.avatar });
      }
    }
  });

  socket.on('stopTyping', () => {
    const user = activeSockets[socket.id];
    if (user) {
      if (user.activeTarget.type === 'room') {
        socket.to('room_' + user.activeTarget.id).emit('userStopTyping', { id: socket.id });
      } else if (user.activeTarget.type === 'dm') {
        socket.to('dm_' + user.activeTarget.id).emit('userStopTyping', { id: socket.id });
      }
    }
  });

  // Enviar Mensagem Chat
  socket.on('chatMessage', (data) => {
    const user = activeSockets[socket.id];
    if (!user || !data.text || data.text.trim() === '') return;

    if (user.activeTarget.type === 'room') {
      const roomName = user.activeTarget.id;
      const room = rooms[roomName];

      // Verificar Mute
      if (room && room.muted[user.username] && room.muted[user.username] > Date.now()) {
        const remaining = Math.ceil((room.muted[user.username] - Date.now()) / 60000);
        return socket.emit('errorMsg', `Estás silenciado neste grupo durante mais ${remaining} minuto(s)!`);
      }

      const messageData = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        senderId: socket.id,
        user: user.username,
        avatar: user.avatar,
        text: data.text.trim(),
        replyTo: data.replyTo || null,
        isAdmin: isRoomAdmin(user.username, roomName),
        isSystem: false,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      if (!roomStore[roomName]) roomStore[roomName] = [];
      roomStore[roomName].push(messageData);

      io.to('room_' + roomName).emit('message', messageData);

    } else if (user.activeTarget.type === 'dm') {
      const dmKey = user.activeTarget.id;

      const messageData = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        senderId: socket.id,
        user: user.username,
        avatar: user.avatar,
        text: data.text.trim(),
        replyTo: data.replyTo || null,
        isSystem: false,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      if (!dmStore[dmKey]) dmStore[dmKey] = [];
      dmStore[dmKey].push(messageData);

      io.to('dm_' + dmKey).emit('message', messageData);

      // Notificar amigo se não estiver com a DM aberta
      const otherUsername = user.activeTarget.withUser;
      const otherSocket = getSocketByUsername(otherUsername);
      if (otherSocket) {
        const otherUserObj = activeSockets[otherSocket.id];
        if (!otherUserObj || otherUserObj.activeTarget.type !== 'dm' || otherUserObj.activeTarget.id !== dmKey) {
          otherSocket.emit('unreadDMNotification', {
            from: user.username,
            avatar: user.avatar,
            text: messageData.text
          });
        }
      }
    }
  });

  // --- RECURSOS DE MODERAÇÃO / ADMIN ---

  // 1. Apagar Mensagem
  socket.on('deleteMessage', (msgId) => {
    const user = activeSockets[socket.id];
    if (!user) return;

    if (user.activeTarget.type === 'room') {
      const roomName = user.activeTarget.id;
      const store = roomStore[roomName] || [];
      const msg = store.find(m => m.id === msgId);

      if (!msg) return;

      const isAdmin = isRoomAdmin(user.username, roomName);
      const isOwnerOfMsg = msg.user.toLowerCase() === user.username.toLowerCase();

      if (isAdmin || isOwnerOfMsg) {
        msg.text = '⚠️ [Mensagem apagada]';
        msg.isDeleted = true;
        io.to('room_' + roomName).emit('messageDeleted', { msgId, deletedBy: user.username });
      } else {
        socket.emit('errorMsg', 'Não tens permissão para apagar esta mensagem!');
      }
    } else if (user.activeTarget.type === 'dm') {
      const dmKey = user.activeTarget.id;
      const store = dmStore[dmKey] || [];
      const msg = store.find(m => m.id === msgId);

      if (msg && msg.user.toLowerCase() === user.username.toLowerCase()) {
        msg.text = '⚠️ [Mensagem apagada]';
        msg.isDeleted = true;
        io.to('dm_' + dmKey).emit('messageDeleted', { msgId, deletedBy: user.username });
      }
    }
  });

  // 2. Silenciar / Dessilenciar Utilizador
  socket.on('muteUser', (data) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser || currentUser.activeTarget.type !== 'room') return;

    const currentRoom = currentUser.activeTarget.id;
    const room = rooms[currentRoom];
    if (!isRoomAdmin(currentUser.username, currentRoom)) {
      return socket.emit('errorMsg', 'Apenas Administradores podem silenciar utilizadores!');
    }

    const targetUsername = data.targetUsername;
    const minutes = parseInt(data.minutes) || 5;

    if (targetUsername.toLowerCase() === currentUser.username.toLowerCase()) {
      return socket.emit('errorMsg', 'Não podes silenciar-te a ti próprio!');
    }

    room.muted[targetUsername] = Date.now() + minutes * 60 * 1000;

    io.to('room_' + currentRoom).emit('message', {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      user: 'Sistema',
      avatar: '🔇',
      text: `${targetUsername} foi silenciado(a) por ${currentUser.username} durante ${minutes} minuto(s).`,
      isSystem: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    const targetSocket = getSocketByUsername(targetUsername);
    if (targetSocket) {
      targetSocket.emit('errorMsg', `Foste silenciado no grupo #${currentRoom} durante ${minutes} minuto(s).`);
    }

    io.to('room_' + currentRoom).emit('updateUsers', getRoomUsersList(currentRoom));
  });

  socket.on('unmuteUser', (targetUsername) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser || currentUser.activeTarget.type !== 'room') return;

    const currentRoom = currentUser.activeTarget.id;
    const room = rooms[currentRoom];
    if (!isRoomAdmin(currentUser.username, currentRoom)) return;

    delete room.muted[targetUsername];

    io.to('room_' + currentRoom).emit('message', {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      user: 'Sistema',
      avatar: '🔊',
      text: `${targetUsername} foi dessilenciado(a) por ${currentUser.username}.`,
      isSystem: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    io.to('room_' + currentRoom).emit('updateUsers', getRoomUsersList(currentRoom));
  });

  // 3. Expulsar Utilizador do Grupo
  socket.on('kickUser', (targetUsername) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser || currentUser.activeTarget.type !== 'room') return;

    const currentRoom = currentUser.activeTarget.id;
    if (!isRoomAdmin(currentUser.username, currentRoom)) {
      return socket.emit('errorMsg', 'Apenas Administradores podem expulsar utilizadores!');
    }

    if (targetUsername.toLowerCase() === currentUser.username.toLowerCase()) {
      return socket.emit('errorMsg', 'Não podes expulsar-te a ti próprio!');
    }

    const targetSocket = getSocketByUsername(targetUsername);

    io.to('room_' + currentRoom).emit('message', {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      user: 'Sistema',
      avatar: '🚫',
      text: `${targetUsername} foi expulsó(a) do grupo por ${currentUser.username}.`,
      isSystem: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    if (targetSocket) {
      const targetUser = activeSockets[targetSocket.id];
      if (targetUser && targetUser.activeTarget.type === 'room' && targetUser.activeTarget.id === currentRoom) {
        targetSocket.emit('youWereKicked', { roomName: currentRoom });
        
        // Move para a sala Geral se não for a Geral
        if (currentRoom !== 'Geral') {
          targetUser.activeTarget = { type: 'room', id: 'Geral' };
          targetSocket.leave('room_' + currentRoom);
          targetSocket.join('room_Geral');
          
          targetSocket.emit('roomSwitched', {
            roomName: 'Geral',
            isAdmin: isRoomAdmin(targetUser.username, 'Geral'),
            history: roomStore['Geral'] || []
          });

          io.to('room_Geral').emit('updateUsers', getRoomUsersList('Geral'));
        }
      }
    }

    io.to('room_' + currentRoom).emit('updateUsers', getRoomUsersList(currentRoom));
  });

  // 4. Banir Utilizador do Grupo
  socket.on('banUser', (targetUsername) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser || currentUser.activeTarget.type !== 'room') return;

    const currentRoom = currentUser.activeTarget.id;
    const room = rooms[currentRoom];
    if (!isRoomAdmin(currentUser.username, currentRoom)) {
      return socket.emit('errorMsg', 'Apenas Administradores podem banir utilizadores!');
    }

    if (targetUsername.toLowerCase() === currentUser.username.toLowerCase()) {
      return socket.emit('errorMsg', 'Não podes banir-te a ti próprio!');
    }

    if (!room.banned.includes(targetUsername)) {
      room.banned.push(targetUsername);
    }

    io.to('room_' + currentRoom).emit('message', {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      user: 'Sistema',
      avatar: '⛔',
      text: `${targetUsername} foi BANIDO(A) do grupo por ${currentUser.username}.`,
      isSystem: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    const targetSocket = getSocketByUsername(targetUsername);
    if (targetSocket) {
      const targetUser = activeSockets[targetSocket.id];
      if (targetUser && targetUser.activeTarget.type === 'room' && targetUser.activeTarget.id === currentRoom) {
        targetSocket.emit('errorMsg', `Foste banido permanentemente do grupo #${currentRoom}!`);
        
        if (currentRoom !== 'Geral') {
          targetUser.activeTarget = { type: 'room', id: 'Geral' };
          targetSocket.leave('room_' + currentRoom);
          targetSocket.join('room_Geral');
          targetSocket.emit('roomSwitched', {
            roomName: 'Geral',
            isAdmin: isRoomAdmin(targetUser.username, 'Geral'),
            history: roomStore['Geral'] || []
          });
          io.to('room_Geral').emit('updateUsers', getRoomUsersList('Geral'));
        }
      }
    }

    io.to('room_' + currentRoom).emit('updateUsers', getRoomUsersList(currentRoom));
  });

  // 5. Desbanir Utilizador
  socket.on('unbanUser', (targetUsername) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser || currentUser.activeTarget.type !== 'room') return;

    const currentRoom = currentUser.activeTarget.id;
    const room = rooms[currentRoom];
    if (!isRoomAdmin(currentUser.username, currentRoom)) return;

    room.banned = room.banned.filter(u => u.toLowerCase() !== targetUsername.toLowerCase());
    socket.emit('successMsg', `${targetUsername} foi desbanido do grupo #${currentRoom}!`);
  });

  // 6. Promover a Admin do Grupo
  socket.on('promoteAdmin', (targetUsername) => {
    const currentUser = activeSockets[socket.id];
    if (!currentUser || currentUser.activeTarget.type !== 'room') return;

    const currentRoom = currentUser.activeTarget.id;
    const room = rooms[currentRoom];
    if (!isRoomAdmin(currentUser.username, currentRoom)) return;

    if (!room.admins.includes(targetUsername)) {
      room.admins.push(targetUsername);
    }

    io.to('room_' + currentRoom).emit('message', {
      id: Date.now() + Math.random().toString(36).substring(2, 7),
      user: 'Sistema',
      avatar: '👑',
      text: `${targetUsername} foi promovido(a) a Administrador(a) do grupo por ${currentUser.username}.`,
      isSystem: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    io.to('room_' + currentRoom).emit('updateUsers', getRoomUsersList(currentRoom));
  });

  // Desconexão
  socket.on('disconnect', () => {
    const user = activeSockets[socket.id];
    if (user) {
      const username = user.username;
      delete activeSockets[socket.id];

      if (user.activeTarget.type === 'room') {
        const room = user.activeTarget.id;
        socket.to('room_' + room).emit('userStopTyping', { id: socket.id });
        io.to('room_' + room).emit('message', {
          id: Date.now() + Math.random().toString(36).substring(2, 7),
          user: 'Sistema',
          avatar: '⚙️',
          text: `${username} ficou offline.`,
          isSystem: true,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        io.to('room_' + room).emit('updateUsers', getRoomUsersList(room));
      }

      notifyFriendsStatusChange(username);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Talkon v4.0 Moderação] Servidor ativo em http://0.0.0.0:${PORT}`);
});
