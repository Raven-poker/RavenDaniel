const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Table = require('./game/table');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

const tables = new Map(); // code -> Table

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function genCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (tables.has(code));
  return code;
}

function clampInt(v, min, max, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

io.on('connection', (socket) => {
  let table = null;
  let token = null;

  socket.on('createRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    const name = String(data?.name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '名前を入力してください' });
    const sb = clampInt(data?.sb, 1, 1e8, 50);
    const bb = clampInt(data?.bb, sb, 1e8, Math.max(100, sb));
    const buyIn = clampInt(data?.buyIn, bb, 1e9, Math.max(10000, bb * 100));
    const maxBuyIn = clampInt(data?.maxBuyIn, buyIn, 1e9, Math.max(10000, buyIn));
    const code = genCode();
    const t = new Table(io, code, { sb, bb, buyIn, maxBuyIn });
    tables.set(code, t);
    token = String(data?.token || crypto.randomUUID());
    table = t;
    socket.join(code);
    t.addPlayer(name, token, socket.id);
    cb({ ok: true, code, token, logs: t.logs });
    t.broadcast();
  });

  socket.on('joinRoom', (data, cb) => {
    if (typeof cb !== 'function') return;
    const code = String(data?.code || '').trim().toUpperCase();
    const t = tables.get(code);
    if (!t) return cb({ error: 'ルームが見つかりません' });
    token = String(data?.token || crypto.randomUUID());
    const existing = t.findPlayer(token);
    if (existing) {
      table = t;
      socket.join(code);
      t.reconnect(existing, socket.id);
      cb({ ok: true, code, token, logs: t.logs });
      t.broadcast();
      return;
    }
    const name = String(data?.name || '').trim().slice(0, 12);
    if (!name) return cb({ error: '名前を入力してください' });
    const sameName = t.players.find((p) => p.name === name);
    if (sameName) {
      // 切断中の同名プレイヤーがいれば、別端末からでもその席に復帰できる
      if (sameName.connected) return cb({ error: 'その名前は使われています' });
      token = sameName.token;
      table = t;
      socket.join(code);
      t.reconnect(sameName, socket.id);
      cb({ ok: true, code, token, logs: t.logs });
      t.broadcast();
      return;
    }
    if (t.players.length >= 9) return cb({ error: 'ルームが満員です (最大9人)' });
    table = t;
    socket.join(code);
    t.addPlayer(name, token, socket.id);
    cb({ ok: true, code, token, logs: t.logs });
    t.broadcast();
  });

  socket.on('startGame', () => {
    if (!table || !token) return;
    if (table.hostToken !== token) return;
    if (table.phase !== 'waiting') return;
    if (table.eligibleCount() < 2) return;
    table.startHand();
  });

  socket.on('action', (data) => {
    if (!table || !token) return;
    table.handleAction(token, String(data?.type || ''), data?.amount);
  });

  socket.on('addChips', (amount) => {
    if (!table || !token) return;
    table.addChips(token, Number(amount));
  });

  socket.on('returnChips', (amount) => {
    if (!table || !token) return;
    table.returnChips(token, Number(amount));
  });

  socket.on('sitOut', (flag) => {
    if (!table || !token) return;
    table.setSitOut(token, !!flag);
  });

  socket.on('leaveRoom', () => {
    if (!table || !token) return;
    table.removePlayer(token);
    socket.leave(table.code);
    if (table.players.length === 0) {
      table.destroy();
      tables.delete(table.code);
    }
    table = null;
    token = null;
  });

  socket.on('disconnect', () => {
    if (table) table.disconnect(socket.id);
  });
});

// 全員が切断したまま2時間経過したルームを掃除
setInterval(() => {
  for (const [code, t] of tables) {
    const allGone = t.players.every((p) => !p.connected);
    if ((t.players.length === 0 || allGone) && Date.now() - t.lastSeen > 2 * 60 * 60 * 1000) {
      t.destroy();
      tables.delete(code);
    }
  }
}, 10 * 60 * 1000);

// 想定外のエラーでもサーバーを落とさずログに残す(ホームゲーム用途のため可用性優先)
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] uncaughtException:`, err);
});
process.on('unhandledRejection', (err) => {
  console.error(`[${new Date().toISOString()}] unhandledRejection:`, err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker cash game server: http://localhost:${PORT}`);
});
