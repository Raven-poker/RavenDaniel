/* global io */
const socket = io();

const $ = (id) => document.getElementById(id);
const SUIT_CH = ['♠', '♥', '♦', '♣'];
const RANK_CH = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

let state = null;
let raiseTo = 0;

const fmt = (n) => Number(n).toLocaleString('ja-JP');

// ---------- 接続・入室 ----------

function saved() {
  try { return JSON.parse(localStorage.getItem('poker-session') || 'null'); } catch { return null; }
}
function saveSession(s) { localStorage.setItem('poker-session', JSON.stringify(s)); }
function clearSession() { localStorage.removeItem('poker-session'); }

function onJoined(res) {
  if (res.error) { $('lobbyError').textContent = res.error; return; }
  saveSession({ code: res.code, token: res.token });
  $('lobby').hidden = true;
  $('game').hidden = false;
  $('logList').innerHTML = '';
  (res.logs || []).forEach(addLog);
}

$('createBtn').onclick = () => {
  socket.emit('createRoom', {
    name: $('nameInput').value,
    sb: $('sbInput').value,
    bb: $('bbInput').value,
    buyIn: $('buyInInput').value,
    maxBuyIn: $('maxBuyInInput').value,
    token: crypto.randomUUID(),
  }, onJoined);
};

$('joinBtn').onclick = () => {
  socket.emit('joinRoom', {
    name: $('nameInput').value,
    code: $('codeInput').value,
    token: crypto.randomUUID(),
  }, onJoined);
};

// 再接続(ページ再読み込み・回線断)
function tryRejoin() {
  const s = saved();
  if (!s) return;
  socket.emit('joinRoom', { code: s.code, token: s.token }, (res) => {
    if (res.error) { clearSession(); return; }
    onJoined(res);
  });
}
socket.on('connect', tryRejoin);

// ---------- ヘッダー操作 ----------

$('leaveBtn').onclick = () => {
  if (!confirm('テーブルから退出しますか?')) return;
  socket.emit('leaveRoom');
  clearSession();
  location.reload();
};

$('addChipsBtn').onclick = () => {
  if (!state) return;
  const me = state.players.find((p) => p.you);
  const max = state.config.maxBuyIn;
  const remaining = max ? max - me.stack - me.pendingAdd : Infinity;
  if (remaining <= 0) {
    showToast(`持ち点が上限 ${fmt(max)} に達しています`);
    return;
  }
  const def = Math.min(state.config.buyIn, remaining);
  const hint = max ? ` (上限 ${fmt(max)}、あと ${fmt(remaining)} まで)` : '';
  const v = prompt(`追加するチップ数${hint}`, def);
  if (v === null) return;
  const n = Math.floor(Number(v));
  if (n > 0) socket.emit('addChips', n);
};

$('returnChipsBtn').onclick = () => {
  if (!state) return;
  const me = state.players.find((p) => p.you);
  const surplus = me.stack + me.pendingAdd - me.pendingReturn - state.config.buyIn;
  if (surplus <= 0) {
    showToast(`初期持ち点 ${fmt(state.config.buyIn)} を超えた分がありません`);
    return;
  }
  const v = prompt(
    `戻すチップ数 (最大 ${fmt(surplus)})\n戻した分は確定ポイントになり、以降のハンドで失いません`,
    surplus,
  );
  if (v === null) return;
  const n = Math.floor(Number(v));
  if (n > 0) socket.emit('returnChips', n);
};

$('logBtn').onclick = () => {
  $('logPanel').hidden = !$('logPanel').hidden;
};

// 開始ボタンは再描画で作り直されるためイベント委譲で拾う
$('waitingBox').addEventListener('click', (e) => {
  if (e.target.closest('#startBtn')) socket.emit('startGame');
  if (e.target.closest('#waitingInviteBtn')) showInvite();
});

// ---------- スタンプ ----------

const STAMP_LIST = ['🔥', '😎', '💪', '😱', '🤔', '😂', '👀', '🐔', '💀', '🙏', '💰', '😏'];
let seatPosByName = {};

STAMP_LIST.forEach((s, i) => {
  const b = document.createElement('button');
  b.textContent = s;
  b.onclick = () => {
    socket.emit('sendStamp', i);
    $('stampPicker').hidden = true;
  };
  $('stampPicker').appendChild(b);
});

$('stampBtn').onclick = () => {
  $('stampPicker').hidden = !$('stampPicker').hidden;
};

socket.on('stamp', ({ name, stamp }) => {
  const pos = seatPosByName[name] || [50, 45];
  const el = document.createElement('div');
  el.className = 'stamp-bubble';
  el.textContent = stamp;
  el.style.left = `${pos[0]}%`;
  el.style.top = `${Math.max(4, pos[1] - 9)}%`;
  $('stampLayer').appendChild(el);
  setTimeout(() => el.remove(), 2800);
});

// ---------- QR招待 ----------

function inviteUrl() {
  return `${location.origin}${location.pathname}?room=${state.code}`;
}

function showInvite() {
  if (!state || typeof qrcode === 'undefined') return;
  const url = inviteUrl();
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  $('qrBox').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
  $('inviteCode').textContent = state.code;
  $('inviteUrl').textContent = url;
  $('inviteWarn').hidden = !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);
  $('copyUrlBtn').textContent = 'URLをコピー';
  $('inviteModal').hidden = false;
}

$('inviteBtn').onclick = showInvite;
$('inviteClose').onclick = () => { $('inviteModal').hidden = true; };
$('inviteModal').onclick = (e) => {
  if (e.target === $('inviteModal')) $('inviteModal').hidden = true;
};
$('copyUrlBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    $('copyUrlBtn').textContent = 'コピーしました ✓';
  } catch {
    $('copyUrlBtn').textContent = 'コピーできませんでした';
  }
};

// QRから来た場合 (?room=XXXX) はコードを自動入力
{
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    $('codeInput').value = roomParam.toUpperCase().slice(0, 4);
    $('nameInput').focus();
  }
}

// ---------- 描画 ----------

function cardHTML(c, sm) {
  if (!c) return `<div class="card back${sm ? ' sm' : ''}"></div>`;
  const red = c.s === 1 || c.s === 2;
  const r = RANK_CH[c.r] || c.r;
  return `<div class="card${red ? ' red' : ''}${sm ? ' sm' : ''}">${r}<span>${SUIT_CH[c.s]}</span></div>`;
}

// 自分を除いた相手の座席位置 (left%, top%)
const SEAT_POS = {
  1: [[50, 12]],
  2: [[16, 28], [84, 28]],
  3: [[12, 42], [50, 10], [88, 42]],
  4: [[10, 52], [22, 16], [78, 16], [90, 52]],
  5: [[8, 55], [18, 20], [50, 8], [82, 20], [92, 55]],
  6: [[8, 58], [14, 24], [36, 9], [64, 9], [86, 24], [92, 58]],
  7: [[7, 60], [12, 28], [30, 10], [50, 7], [70, 10], [88, 28], [93, 60]],
  8: [[6, 62], [10, 32], [26, 12], [44, 7], [62, 7], [78, 12], [90, 32], [94, 62]],
};

function seatHTML(p, pos, isMe) {
  const cls = ['seat'];
  if (p.acting) cls.push('acting');
  if (p.folded) cls.push('folded');
  if (!p.connected || p.sittingOut) cls.push('away');
  const sm = !isMe;

  let cards = '';
  if (p.cards) cards = p.cards.map((c) => cardHTML(c, sm)).join('');
  else if (p.hasCards) cards = cardHTML(null, sm) + cardHTML(null, sm);

  let status = '';
  if (!p.connected) status = '切断中';
  else if (p.sittingOut) status = '離席中';
  else if (p.folded) status = 'フォールド';
  else if (p.inHand && p.stack === 0) status = 'オールイン';

  const profitCls = p.profit > 0 ? 'plus' : p.profit < 0 ? 'minus' : '';
  const profitTxt = `${p.profit >= 0 ? '+' : ''}${fmt(p.profit)}`;
  let pending = p.pendingAdd > 0 ? ` (+${fmt(p.pendingAdd)}予約)` : '';
  if (p.pendingReturn > 0) pending += ` (−${fmt(p.pendingReturn)}予約)`;

  return `<div class="${cls.join(' ')}" style="left:${pos[0]}%;top:${pos[1]}%">
    ${pos[1] > 50 || isMe ? `<div class="cards">${cards}</div>` : ''}
    <div class="pod">
      ${p.dealer ? '<div class="dealer-btn">D</div>' : ''}
      <div class="pname">${esc(p.name)}${isMe ? ' (あなた)' : ''}</div>
      <div class="pstack">${fmt(p.stack)}${pending}</div>
      <div class="pprofit ${profitCls}">ポイント ${profitTxt}</div>
      ${p.banked > 0 ? `<div class="pbank">確定 ${fmt(p.banked)}</div>` : ''}
      ${p.handName ? `<div class="phand">${p.handName}</div>` : ''}
      ${status ? `<div class="pstatus">${status}</div>` : ''}
    </div>
    ${pos[1] <= 50 && !isMe ? `<div class="cards">${cards}</div>` : ''}
    ${p.bet > 0 ? `<div class="bet-chip">${fmt(p.bet)}</div>` : ''}
  </div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  if (!state) return;
  const st = state;

  $('roomInfo').innerHTML = `ルーム <b>${st.code}</b> ・ ${fmt(st.config.sb)}/${fmt(st.config.bb)}`
    + (st.config.maxBuyIn ? ` ・ Max ${fmt(st.config.maxBuyIn)}` : '');

  // ボードとポット
  $('board').innerHTML = st.board.map((c) => cardHTML(c)).join('');
  $('potLabel').textContent = st.pot > 0 ? `ポット ${fmt(st.pot)}` : '';

  // 座席: 自分を先頭に並べ替え
  const meIdx = st.players.findIndex((p) => p.you);
  const ordered = meIdx >= 0
    ? [...st.players.slice(meIdx), ...st.players.slice(0, meIdx)]
    : st.players;
  const me = ordered[0];
  const others = ordered.slice(1);
  const posList = SEAT_POS[Math.min(others.length, 8)] || [];
  let html = '';
  seatPosByName = {};
  if (me && me.you) {
    html += seatHTML(me, [50, 86], true);
    seatPosByName[me.name] = [50, 86];
  }
  others.forEach((p, i) => {
    const pos = posList[i] || [50, 12];
    html += seatHTML(p, pos, false);
    seatPosByName[p.name] = pos;
  });
  $('seats').innerHTML = html;

  // 結果・待機表示
  const rb = $('resultBox');
  if (st.lastResult) {
    rb.hidden = false;
    rb.innerHTML = st.lastResult.lines.map(esc).join('<br>')
      + '<br><small style="color:var(--muted)">まもなく次のハンド…</small>';
  } else rb.hidden = true;

  const wb = $('waitingBox');
  if (st.phase === 'waiting') {
    wb.hidden = false;
    const n = st.players.length;
    let msg = st.started
      ? '対戦できるプレイヤーを待っています…'
      : `プレイヤー待機中 (${n}人)<br>ルームコード <b style="color:var(--gold);letter-spacing:2px">${st.code}</b> を友だちに伝えてください`;
    if (!st.started) {
      msg += '<br><button id="waitingInviteBtn" class="small gold" style="margin-top:8px">QRで招待</button>';
    }
    if (!st.started && st.isHost) {
      msg += '<br><button id="startBtn" class="primary" style="width:auto;padding:10px 24px">ゲーム開始</button>';
    }
    wb.innerHTML = msg;
  } else wb.hidden = true;

  renderActions(st);
  document.title = st.turn ? '🔔 あなたの番! - Poker Legends' : 'Poker Legends';
}

function renderActions(st) {
  const bar = $('actionBar');
  if (!st.turn) { bar.hidden = true; return; }
  bar.hidden = false;
  const t = st.turn;

  $('foldBtn').disabled = false;

  const cc = $('checkCallBtn');
  if (t.canCheck) cc.textContent = 'チェック';
  else cc.textContent = t.toCall >= st.players.find((p) => p.you).stack
    ? `コール ${fmt(t.toCall)} (All-in)` : `コール ${fmt(t.toCall)}`;

  const rb = $('raiseBtn');
  const rr = $('raiseRow');
  if (t.canRaise) {
    rb.hidden = false; rr.hidden = false;
    const slider = $('raiseSlider');
    slider.min = t.minRaiseTo;
    slider.max = t.maxRaiseTo;
    slider.step = 1;
    if (raiseTo < t.minRaiseTo || raiseTo > t.maxRaiseTo) raiseTo = t.minRaiseTo;
    setRaise(raiseTo, st, false);
  } else {
    rb.hidden = true; rr.hidden = true;
  }
}

// レイズ額を設定 (snap=true なら BB の倍数に丸める)
function setRaise(v, st, snap = true) {
  const t = st.turn;
  if (!t) return;
  if (snap) v = Math.round(v / st.config.bb) * st.config.bb;
  v = Math.max(t.minRaiseTo, Math.min(t.maxRaiseTo, Math.floor(v)));
  raiseTo = v;
  $('raiseSlider').value = v;
  $('raiseAmount').textContent = fmt(v);
  updateRaiseBtn(st);
}

function updateRaiseBtn(st) {
  const t = st.turn;
  if (!t) return;
  const isAllin = raiseTo >= t.maxRaiseTo;
  const label = st.currentBet === 0 ? 'ベット' : 'レイズ';
  $('raiseBtn').textContent = `${label} ${fmt(raiseTo)}${isAllin ? ' (All-in)' : ''}`;
}

$('raiseSlider').oninput = (e) => {
  if (state) setRaise(Number(e.target.value), state);
};
$('raiseMinus').onclick = () => {
  if (state) setRaise(raiseTo - state.config.bb, state);
};
$('raisePlus').onclick = () => {
  if (state) setRaise(raiseTo + state.config.bb, state);
};

document.querySelectorAll('#raisePresets button').forEach((b) => {
  b.onclick = () => {
    if (!state || !state.turn) return;
    const t = state.turn;
    if (b.dataset.preset === 'min') setRaise(t.minRaiseTo, state, false);
    else if (b.dataset.preset === 'half') setRaise(t.halfPotRaiseTo, state);
    else if (b.dataset.preset === 'pot') setRaise(t.potRaiseTo, state);
    else setRaise(t.maxRaiseTo, state, false);
  };
});

$('foldBtn').onclick = () => act('fold');
$('checkCallBtn').onclick = () => {
  if (!state || !state.turn) return;
  act(state.turn.canCheck ? 'check' : 'call');
};
$('raiseBtn').onclick = () => act('raise', raiseTo);

function act(type, amount) {
  socket.emit('action', { type, amount });
  $('actionBar').hidden = true; // 次の state まで一旦隠す
}

// ---------- ソケットイベント ----------

socket.on('state', (st) => {
  state = st;
  render();
});

function addLog(msg) {
  const div = document.createElement('div');
  if (msg.startsWith('――')) div.className = 'hr';
  div.textContent = msg;
  $('logList').appendChild(div);
  while ($('logList').children.length > 120) $('logList').firstChild.remove();
  $('logList').parentElement.scrollTop = 1e9;
}
socket.on('log', addLog);

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}
socket.on('errorMsg', showToast);
