const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 120000,
  pingInterval: 30000,
  connectTimeout: 60000,
  transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3000;

// ─── In-memory room store ───────────────────────────────────────────────────
const rooms = {}; // roomCode → Room

// ─── Game Logic (same rules as frontend) ────────────────────────────────────
const VALUE_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const ALWAYS_PLAY = new Set(['2','3','10']);

const nv  = v => VALUE_ORDER.indexOf(v);
const uid = (() => { let i=0; return ()=>++i; })();

function createDeck() {
  return ['♠','♥','♦','♣'].flatMap(s => VALUE_ORDER.map(v => ({ value:v, suit:s, id:uid() })));
}
function shuffle(a) {
  const arr=[...a];
  for (let i=arr.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function effTop(pile) {
  for (let i=pile.length-1;i>=0;i--) if (pile[i].value!=='3') return pile[i].value;
  return null;
}
function canPlay(card, pile, mustLower) {
  if (ALWAYS_PLAY.has(card.value)) return true;
  const top = effTop(pile);
  if (!top) return true;
  // Jack cannot be played directly on a 7 (but CAN if 3/mirror is on top)
  if (card.value==='J' && pile.length>0 && pile[pile.length-1].value==='7') return false;
  // Jack follows normal ordering (must be >= top, or < top when mustLower)
  return mustLower ? nv(card.value)<nv(top) : nv(card.value)>=nv(top);
}
function topCount(pile) {
  if (!pile.length) return 0;
  const v=pile[pile.length-1].value; let n=0;
  for (let i=pile.length-1;i>=0&&pile[i].value===v;i--) n++;
  return n;
}
function updatePhase(p) {
  if (p.phase==='hand'&&p.hand.length===0) {
    if (p.tabUp.length>0)   return {...p,phase:'tabUp'};
    if (p.tabDown.length>0) return {...p,phase:'tabDown'};
    return {...p,finished:true};
  }
  if (p.phase==='tabUp'&&p.tabUp.length===0) {
    if (p.tabDown.length>0) return {...p,phase:'tabDown'};
    return {...p,finished:true};
  }
  if (p.phase==='tabDown'&&p.tabDown.length===0) return {...p,finished:true};
  return p;
}
function nextIdx(players, from) {
  const n=players.length; let i=(from+1)%n, t=0;
  while (players[i].finished&&t<n) { i=(i+1)%n; t++; }
  return i;
}
function checkWin(state) {
  if (state.players.filter(p=>!p.finished).length<=1) {
    state.status='won';
    const w=state.players.find(p=>p.rank===1);
    state.winner=w?.name||state.players[state.currentIdx].name;
    state.log=`🏆 ${state.winner} gewinnt!`;
  }
  return state;
}
function initGame(playerInfos, doubleDeck=false) {
  let deck = shuffle([...createDeck(),...(doubleDeck?createDeck():[])]);
  const players = playerInfos.map((p,i) => ({
    id:       p.id,
    name:     p.name,
    emoji:    p.emoji,
    socketId: p.socketId,
    hand:     deck.splice(0,3),
    tabDown:  deck.splice(0,3),
    tabUp:    deck.splice(0,3),
    phase:    'hand',
    finished: false,
    rank:     null,
  }));
  const startIdx = Math.floor(Math.random()*players.length);
  return { players, deck, pile:[], removed:[], mustLower:false, skip:false,
           currentIdx:startIdx, log:`${players[startIdx].name} beginnt!`,
           status:'playing', winner:null, tick:0 };
}

function applyCards(cards, state) {
  const s = JSON.parse(JSON.stringify(state));
  const pi=s.currentIdx, p=s.players[pi];
  const val=cards[0].value;
  const ids=new Set(cards.map(c=>c.id));

  if      (p.phase==='hand')  p.hand   =p.hand.filter(c=>!ids.has(c.id));
  else if (p.phase==='tabUp') p.tabUp  =p.tabUp.filter(c=>!ids.has(c.id));
  else                        p.tabDown=p.tabDown.filter(c=>!ids.has(c.id));

  s.pile.push(...cards);
  if (p.phase==='hand') while (p.hand.length<3&&s.deck.length>0) p.hand.push(s.deck.shift());

  s.players[pi]=updatePhase(p);
  if (s.players[pi].finished&&s.players[pi].rank===null)
    s.players[pi].rank=s.players.filter(pl=>pl.rank!==null).length+1;

  const shouldClear=val==='10'||topCount(s.pile)>=4;
  if (shouldClear) {
    s.removed.push(...s.pile); s.pile=[];
    s.mustLower=false; s.skip=false;
    s.log=val==='10'?`${p.name} – 10! Stapel weg 💥`:`4× ${val}! Stapel weg 💥`;
    s.tick++;
    return checkWin(s);
  }

  s.mustLower=false; s.skip=false;
  if      (val==='2') s.log=`${p.name} – Reset ♻️`;
  else if (val==='7') { s.mustLower=true; s.log=`${p.name} – 7! Nächster tiefer ↓`; }
  else if (val==='J') { s.skip=true;      s.log=`${p.name} – Bube! Aussetzen ⊘`; }
  else if (val==='3') { const e=effTop(s.pile); s.log=`${p.name} – 3 Spiegel (${e||'?'})`; }
  else s.log=`${p.name} legt ${cards.length>1?cards.length+'× ':''}${val}${cards[0].suit}`;

  checkWin(s);
  if (s.status==='won') return s;

  let ni=nextIdx(s.players, pi);
  if (s.skip) { ni=nextIdx(s.players,ni); s.skip=false; }
  s.currentIdx=ni;
  s.log+=` · ${s.players[ni].name} ist dran`;
  if (s.mustLower) s.log+=' (tiefer!)';
  s.tick++;
  return s;
}

function applyTakeStack(state) {
  const s=JSON.parse(JSON.stringify(state));
  const pi=s.currentIdx, p=s.players[pi];
  const n=s.pile.length;
  p.hand.push(...s.pile); s.pile=[];
  s.mustLower=false; s.skip=false;
  if (p.phase!=='hand') p.phase='hand';
  s.players[pi]=p;
  s.log=`${p.name} nimmt den Stapel (${n} Karten)`;
  const ni=nextIdx(s.players,pi);
  s.currentIdx=ni;
  s.log+=` · ${s.players[ni].name} ist dran`;
  s.tick++;
  return s;
}

function applyBlind(cardId, state) {
  const s=JSON.parse(JSON.stringify(state));
  const pi=s.currentIdx, p=s.players[pi];
  const idx=p.tabDown.findIndex(c=>c.id===cardId);
  if (idx===-1) return s;
  const card=p.tabDown[idx];
  if (canPlay(card,s.pile,s.mustLower)) return applyCards([card],s);
  p.tabDown.splice(idx,1);
  const n=s.pile.length;
  p.hand.push(card,...s.pile); s.pile=[];
  // Force hand phase even if tabDown now empty - card failed so player gets stack
  p.phase='hand'; p.finished=false; p.rank=null;
  s.mustLower=false; s.skip=false; s.players[pi]=p;
  s.log=`${p.name} – ${card.value}${card.suit} passt nicht! Stapel auf die Hand`;
  const ni=nextIdx(s.players,pi);
  s.currentIdx=ni;
  s.log+=` · ${s.players[ni].name} ist dran`;
  s.tick++;
  return s;
}

// ─── Helper: build view of game state for a specific player ─────────────────
// Each player sees their own full hand, others only see count
function stateForPlayer(state, playerIdx) {
  return {
    ...state,
    players: state.players.map((p,i) => {
      if (i===playerIdx) return p; // full info for self
      return {
        ...p,
        hand:     p.hand.map(()=>({hidden:true})), // hide hand cards
        tabDown:  p.tabDown.map(()=>({hidden:true})),
        // tabUp is visible to all
      };
    }),
    deck: state.deck.length, // only send count
  };
}

// ─── Generate room code ──────────────────────────────────────────────────────
function genCode() {
  const c='BCDFGHJKLMNPQRSTVWXYZ';
  return Array.from({length:5},()=>c[Math.floor(Math.random()*c.length)]).join('');
}

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  // ── CREATE ROOM ────────────────────────────────────────────────────────────
  socket.on('create_room', ({ name, emoji, settings }, cb) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const player = { id:0, socketId:socket.id, name, emoji };
    rooms[code] = {
      code,
      host:     socket.id,
      settings: settings||{ showHints:false, doubleDeck:false },
      players:  [player],
      state:    null,
      phase:    'lobby', // lobby | game
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerIdx = 0;
    cb({ ok:true, code, playerIdx:0 });
    io.to(code).emit('lobby_update', lobbyView(rooms[code]));
  });

  // ── JOIN ROOM ──────────────────────────────────────────────────────────────
  socket.on('join_room', ({ code, name, emoji }, cb) => {
    const room = rooms[code];
    if (!room)                     return cb({ ok:false, error:'Raum nicht gefunden' });
    if (room.phase!=='lobby')      return cb({ ok:false, error:'Spiel läuft bereits' });
    if (room.players.length>=6)    return cb({ ok:false, error:'Raum ist voll (max. 6)' });

    const idx = room.players.length;
    room.players.push({ id:idx, socketId:socket.id, name, emoji });
    socket.join(code);
    socket.data.roomCode  = code;
    socket.data.playerIdx = idx;
    cb({ ok:true, code, playerIdx:idx, settings:room.settings });
    io.to(code).emit('lobby_update', lobbyView(room));
  });

  // ── PEEK ROOM (get taken emojis before joining) ───────────────────────────
  socket.on('peek_room', ({code}, cb) => {
    const room = rooms[code];
    if (!room || room.phase !== 'lobby') return cb && cb({});
    cb && cb({ takenEmojis: room.players.map(p => p.emoji) });
  });

  // ── REACTION ───────────────────────────────────────────────────────────────────
  socket.on('reaction', ({emoji}) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const pi = socket.data.playerIdx;
    const name = room.players[pi]?.name || '';
    io.to(room.code).emit('reaction', {emoji, name});
  });

  // ── SET EMOJI (after joining) ─────────────────────────────────────────────────
  socket.on('set_emoji', ({emoji}) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const pi = socket.data.playerIdx;
    if (room.players[pi]) room.players[pi].emoji = emoji;
    socket.emit('emoji_confirmed', {emoji});
    io.to(room.code).emit('lobby_update', lobbyView(room));
  });

  // ── RECONNECT ─────────────────────────────────────────────────────────────────
  socket.on('reconnect_player', ({code, playerIdx}) => {
    const room = rooms[code];
    if (!room || playerIdx >= room.players.length) return;
    const p = room.players[playerIdx];
    // Cancel disconnect timer
    if (socket.data.disconnectTimer) clearTimeout(socket.data.disconnectTimer);
    // Update socket ID
    p.socketId = socket.id;
    p.disconnected = false;
    socket.data.roomCode = code;
    socket.data.playerIdx = playerIdx;
    socket.join(code);
    socket.emit('reconnect_ok', {name:p.name, emoji:p.emoji, roomCode:code, playerIdx});
    if (room.phase==='game' && room.state) {
      socket.emit('game_state', stateForPlayer(room.state, playerIdx));
    } else {
      socket.emit('lobby_update', lobbyView(room));
    }
    io.to(code).emit('lobby_update', lobbyView(room));
    console.log('Player reconnected:', p.name);
  });

  // ── UPDATE SETTINGS (host only) ────────────────────────────────────────────
  socket.on('update_settings', (settings) => {
    const room = rooms[socket.data.roomCode];
    if (!room||room.host!==socket.id) return;
    room.settings = settings;
    io.to(room.code).emit('lobby_update', lobbyView(room));
  });

  // ── START GAME ─────────────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const room = rooms[socket.data.roomCode];
    if (!room||room.host!==socket.id) return;
    if (room.players.length<2) return;

    room.phase = 'game';
    room.state = initGame(room.players, room.settings.doubleDeck);
    console.log('Game started, startIdx:', room.state.currentIdx, 
      'players:', room.players.map(p=>p.name));
    broadcastGameState(room);
  });

  // ── PLAY CARDS ─────────────────────────────────────────────────────────────
  socket.on('play_cards', (cards) => {
    const room = rooms[socket.data.roomCode];
    if (!room||room.phase!=='game') return;
    const pi = socket.data.playerIdx;
    if (room.state.currentIdx!==pi) return;
    if (!cards.length) return;
    if (!canPlay(cards[0], room.state.pile, room.state.mustLower)) return;

    // Validate cards belong to player
    const player = room.state.players[pi];
    const src = player.phase==='hand' ? player.hand
              : player.phase==='tabUp' ? player.tabUp : player.tabDown;
    const ids = new Set(cards.map(c=>c.id));
    if (!cards.every(c=>src.find(s=>s.id===c.id))) return;

    room.state = applyCards(cards, room.state);
    broadcastGameState(room);
  });

  // ── TAKE STACK ─────────────────────────────────────────────────────────────
  socket.on('take_stack', () => {
    const room = rooms[socket.data.roomCode];
    if (!room||room.phase!=='game') return;
    if (room.state.currentIdx!==socket.data.playerIdx) return;
    room.state = applyTakeStack(room.state);
    broadcastGameState(room);
  });

  // ── PLAY BLIND ─────────────────────────────────────────────────────────────
  socket.on('play_blind', (cardId) => {
    const room = rooms[socket.data.roomCode];
    if (!room||room.phase!=='game') return;
    const pi = socket.data.playerIdx;
    if (room.state.currentIdx!==pi) return;
    if (room.state.players[pi].phase!=='tabDown') return;
    room.state = applyBlind(cardId, room.state);
    broadcastGameState(room);
  });

  // ── PLAY AGAIN ─────────────────────────────────────────────────────────────
  socket.on('play_again', () => {
    const room = rooms[socket.data.roomCode];
    if (!room||room.host!==socket.id) return;
    // Track win stats before resetting
    if (room.state && room.state.status==='won') {
      const winner = room.state.players.find(p=>p.rank===1);
      if (winner) {
        const p = room.players.find(p=>p.name===winner.name);
        if (p) { p.wins = (p.wins||0)+1; }
      }
    }
    room.phase = 'lobby';
    room.state = null;
    io.to(room.code).emit('lobby_update', lobbyView(room));
  });

  // ── REACTION ──────────────────────────────────────────────────────────────────
  socket.on('reaction', ({emoji}) => {
    const room = rooms[socket.data.roomCode];
    if (!room||room.phase!=='game') return;
    const pi = socket.data.playerIdx;
    const name = room.players[pi]?.name||'?';
    io.to(room.code).emit('reaction', {emoji, name});
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log('disconnected:', socket.id, reason);
    const code = socket.data.roomCode;
    if (!code||!rooms[code]) return;
    const room = rooms[code];
    // Mark as disconnected but give 30s to reconnect
    const pi = socket.data.playerIdx;
    if (room.players[pi]) room.players[pi].disconnected = true;
    const disconnectTimer = setTimeout(() => {
      if (!rooms[code]) return;
      // Still disconnected after 30s - actually remove
      room.players = room.players.filter(p=>p.socketId!==socket.id);
      if (room.players.length===0) {
        delete rooms[code];
      } else {
        if (room.host===socket.id) room.host=room.players[0].socketId;
        io.to(code).emit('lobby_update', lobbyView(room));
        if (room.phase==='game') {
          const name = room.players[pi]?.name || 'Ein Spieler';
          io.to(code).emit('player_left', { name });
        }
      }
    }, 30000);
    // Store timer so we can cancel on reconnect
    socket.data.disconnectTimer = disconnectTimer;
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function lobbyView(room) {
  return {
    code:       room.code,
    settings:   room.settings,
    players:    room.players.map((p,i)=>({ name:p.name, emoji:p.emoji, isHost:i===0, wins:p.wins||0 })),
    takenEmojis:room.players.map(p=>p.emoji),
    phase:      room.phase,
  };
}

function broadcastGameState(room) {
  room.players.forEach((p, idx) => {
    const view = stateForPlayer(room.state, idx);
    io.to(p.socketId).emit('game_state', view);
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req,res) => res.send('Shithead server running'));

// ─── Self-ping to prevent Render sleep ─────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  const https = require('https');
  const http  = require('http');
  const lib   = SELF_URL.startsWith('https') ? https : http;
  lib.get(SELF_URL, (res) => {
    console.log('Self-ping:', res.statusCode);
  }).on('error', (e) => {
    console.log('Self-ping failed:', e.message);
  });
}, 10 * 60 * 1000); // every 10 minutes

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
