const { evaluate7 } = require('./evaluator');

const TURN_LIMIT_MS = 45000;
const TURN_LIMIT_DISCONNECTED_MS = 15000;
const NEXT_HAND_MS = 8000;
const BETTING_PHASES = ['preflop', 'flop', 'turn', 'river'];

function newDeck() {
  const d = [];
  for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

class Table {
  constructor(io, code, config) {
    this.io = io;
    this.code = code;
    this.config = config; // { sb, bb, buyIn }
    this.players = [];
    this.hostToken = null;
    this.phase = 'waiting';
    this.board = [];
    this.deck = [];
    this.dealerIndex = -1;
    this.actingIndex = -1;
    this.currentBet = 0;
    this.minRaise = config.bb;
    this.handNumber = 0;
    this.lastResult = null;
    this.turnTimer = null;
    this.turnDeadline = null;
    this.nextHandTimer = null;
    this.logs = [];
    this.fastMode = false; // テスト用: タイマーを使わず同期実行
    this.lastSeen = Date.now();
  }

  // ---- プレイヤー管理 ----

  addPlayer(name, token, socketId) {
    const p = {
      token, name, socketId,
      stack: this.config.buyIn,
      totalBuyIn: this.config.buyIn,
      pendingAdd: 0,
      pendingReturn: 0,
      banked: 0,
      cards: [],
      inHand: false,
      folded: false,
      betStreet: 0,
      committed: 0,
      acted: false,
      revealed: false,
      result: null,
      sittingOut: false,
      connected: true,
    };
    this.players.push(p);
    if (!this.hostToken) this.hostToken = token;
    this.log(`${name} が参加しました (持ち点 ${fmt(p.stack)})`);
    this.maybeResume();
    return p;
  }

  findPlayer(token) {
    return this.players.find((p) => p.token === token);
  }

  reconnect(p, socketId) {
    p.socketId = socketId;
    p.connected = true;
    this.log(`${p.name} が再接続しました`);
    this.maybeResume();
  }

  disconnect(socketId) {
    const p = this.players.find((q) => q.socketId === socketId);
    if (!p) return;
    p.connected = false;
    this.lastSeen = Date.now();
    this.log(`${p.name} の接続が切れました`);
    // 切断した本人の手番なら短いタイマーに切り替えて他の人を待たせない
    if (BETTING_PHASES.includes(this.phase) && this.players[this.actingIndex] === p) {
      this.setTurnTimer();
    }
    this.broadcast();
  }

  removePlayer(token) {
    const i = this.players.findIndex((p) => p.token === token);
    if (i === -1) return;
    const p = this.players[i];
    if (p.inHand && !p.folded && BETTING_PHASES.includes(this.phase)) {
      p.folded = true;
      if (i === this.actingIndex) {
        this.clearTurnTimer();
        p.acted = true;
        this.afterAction();
      } else if (this.onlyOneLive()) {
        this.afterAction();
      }
    }
    const j = this.players.findIndex((q) => q.token === token);
    if (j === -1) return; // 上の afterAction で別の処理が走った場合の保険
    this.players.splice(j, 1);
    if (this.dealerIndex >= j) this.dealerIndex--;
    if (this.actingIndex > j) this.actingIndex--;
    if (this.hostToken === token && this.players.length) this.hostToken = this.players[0].token;
    const profit = p.stack + p.pendingAdd + p.banked - p.totalBuyIn;
    this.log(`${p.name} が退出しました (収支 ${profit >= 0 ? '+' : ''}${fmt(profit)})`);
    this.broadcast();
  }

  addChips(token, amount) {
    const p = this.findPlayer(token);
    if (!p) return;
    amount = Math.floor(amount);
    if (!(amount > 0) || amount > 1e9) return;
    const max = this.config.maxBuyIn || Infinity;
    const current = p.stack + p.pendingAdd;
    if (current + amount > max) {
      const allowed = Math.max(0, max - current);
      return this.sendError(p, allowed > 0
        ? `持ち点の上限は ${fmt(max)} です (あと ${fmt(allowed)} まで追加可)`
        : `持ち点が上限 ${fmt(max)} に達しています`);
    }
    if (this.phase === 'waiting') {
      p.stack += amount;
      p.totalBuyIn += amount;
    } else {
      p.pendingAdd += amount;
    }
    this.log(`${p.name} が ${fmt(amount)} を追加しました${this.phase === 'waiting' ? '' : ' (次のハンドから反映)'}`);
    this.maybeResume();
    this.broadcast();
  }

  // 初期持ち点を超えた分をテーブルから下ろし、確定収支(banked)にする
  returnChips(token, amount) {
    const p = this.findPlayer(token);
    if (!p) return;
    amount = Math.floor(amount);
    if (!(amount > 0) || amount > 1e9) return;
    const surplus = Math.max(0, p.stack + p.pendingAdd - p.pendingReturn - this.config.buyIn);
    if (amount > surplus) {
      return this.sendError(p, surplus > 0
        ? `初期持ち点 ${fmt(this.config.buyIn)} を超えた分 (${fmt(surplus)}) まで戻せます`
        : '初期持ち点を超えた分がありません');
    }
    if (this.phase === 'waiting') {
      p.stack -= amount;
      p.banked += amount;
      this.log(`${p.name} が ${fmt(amount)} を戻して収支を確定しました (確定分 計${fmt(p.banked)})`);
    } else {
      p.pendingReturn += amount;
      this.log(`${p.name} が ${fmt(amount)} の戻しを予約しました (次のハンド前に反映)`);
    }
    this.broadcast();
  }

  setSitOut(token, sitOut) {
    const p = this.findPlayer(token);
    if (!p) return;
    p.sittingOut = !!sitOut;
    this.log(`${p.name} が${sitOut ? '離席しました (次のハンドから)' : '復帰しました'}`);
    if (!sitOut) this.maybeResume();
    this.broadcast();
  }

  eligibleCount() {
    return this.players.filter(
      (p) => !p.sittingOut && p.connected && p.stack + p.pendingAdd > 0,
    ).length;
  }

  maybeResume() {
    if (this.phase === 'waiting' && this.handNumber > 0 && this.eligibleCount() >= 2) {
      this.scheduleNextHand(3000);
    }
  }

  // ---- ハンド進行 ----

  startHand() {
    this.clearNextHandTimer();
    this.lastResult = null;
    // 追加チップを反映
    for (const p of this.players) {
      if (p.pendingAdd > 0) {
        // ハンド中に勝って持ち点が増えた場合などは上限まで切り詰める
        const max = this.config.maxBuyIn || Infinity;
        const add = Math.min(p.pendingAdd, Math.max(0, max - p.stack));
        if (add < p.pendingAdd) {
          this.log(`${p.name} のチップ追加は上限 ${fmt(max)} に合わせて ${fmt(add)} になりました`);
        }
        p.stack += add;
        p.totalBuyIn += add;
        p.pendingAdd = 0;
      }
      if (p.pendingReturn > 0) {
        // ハンドで負けて余剰が減った場合は戻せる分だけ反映する
        const ret = Math.min(p.pendingReturn, Math.max(0, p.stack - this.config.buyIn));
        if (ret < p.pendingReturn) {
          this.log(`${p.name} の戻しは余剰減少のため ${fmt(ret)} になりました`);
        }
        p.pendingReturn = 0;
        if (ret > 0) {
          p.stack -= ret;
          p.banked += ret;
          this.log(`${p.name} が ${fmt(ret)} を戻して収支を確定しました (確定分 計${fmt(p.banked)})`);
        }
      }
      p.cards = [];
      p.folded = false;
      p.betStreet = 0;
      p.committed = 0;
      p.acted = false;
      p.revealed = false;
      p.result = null;
      p.inHand = false;
    }
    const eligible = this.players.filter(
      (p) => !p.sittingOut && p.connected && p.stack > 0,
    );
    if (eligible.length < 2) {
      this.phase = 'waiting';
      this.actingIndex = -1;
      this.broadcast();
      return;
    }
    for (const p of eligible) p.inHand = true;

    this.handNumber++;
    this.board = [];
    this.deck = newDeck();
    this.currentBet = 0;
    this.minRaise = this.config.bb;
    this.phase = 'preflop';

    this.dealerIndex = this.nextIndex(this.dealerIndex, (p) => p.inHand);
    let sbIdx;
    let bbIdx;
    if (eligible.length === 2) {
      sbIdx = this.dealerIndex;
      bbIdx = this.nextIndex(sbIdx, (p) => p.inHand);
    } else {
      sbIdx = this.nextIndex(this.dealerIndex, (p) => p.inHand);
      bbIdx = this.nextIndex(sbIdx, (p) => p.inHand);
    }
    this.log(`―― ハンド #${this.handNumber} ―― ディーラー: ${this.players[this.dealerIndex].name}`);
    this.postBlind(this.players[sbIdx], this.config.sb, 'SB');
    this.postBlind(this.players[bbIdx], this.config.bb, 'BB');
    this.currentBet = this.config.bb;

    for (const p of eligible) p.cards = [this.deck.pop(), this.deck.pop()];

    this.actingIndex = this.nextIndex(bbIdx, (p) => this.canActNow(p));
    if (this.actingIndex === -1) {
      // 全員ブラインドでオールインなどの極端なケース
      this.nextStreet();
      return;
    }
    this.setTurnTimer();
    this.broadcast();
  }

  postBlind(p, amount, label) {
    const pay = Math.min(amount, p.stack);
    this.pay(p, pay);
    this.log(`${p.name} が ${label} ${fmt(pay)} を支払い${p.stack === 0 ? ' (オールイン)' : ''}`);
  }

  pay(p, amount) {
    p.stack -= amount;
    p.betStreet += amount;
    p.committed += amount;
  }

  canActNow(p) {
    return p.inHand && !p.folded && p.stack > 0
      && (!p.acted || p.betStreet < this.currentBet);
  }

  livePlayers() {
    return this.players.filter((p) => p.inHand && !p.folded);
  }

  onlyOneLive() {
    return this.livePlayers().length === 1;
  }

  handleAction(token, type, amount) {
    if (!BETTING_PHASES.includes(this.phase)) return;
    const p = this.players[this.actingIndex];
    if (!p || p.token !== token) return;
    amount = Math.floor(Number(amount)) || 0;
    const toCall = this.currentBet - p.betStreet;

    if (type === 'fold') {
      p.folded = true;
      this.log(`${p.name} がフォールド`);
    } else if (type === 'check') {
      if (toCall > 0) return this.sendError(p, 'チェックできません');
      this.log(`${p.name} がチェック`);
    } else if (type === 'call') {
      if (toCall <= 0) return this.sendError(p, 'コールする額がありません');
      const pay = Math.min(toCall, p.stack);
      this.pay(p, pay);
      this.log(`${p.name} がコール ${fmt(pay)}${p.stack === 0 ? ' (オールイン)' : ''}`);
    } else if (type === 'raise') {
      const maxTo = p.betStreet + p.stack;
      let minTo = this.currentBet === 0 ? this.config.bb : this.currentBet + this.minRaise;
      minTo = Math.min(minTo, maxTo); // オールインならミニマム未満でも可
      if (amount < minTo || amount > maxTo || amount <= this.currentBet) {
        return this.sendError(p, 'レイズ額が不正です');
      }
      const raiseSize = amount - this.currentBet;
      const isBet = this.currentBet === 0;
      this.pay(p, amount - p.betStreet);
      if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
      this.currentBet = amount;
      for (const q of this.players) if (q !== p) q.acted = false;
      this.log(`${p.name} が${isBet ? 'ベット' : 'レイズ'} ${fmt(amount)}${p.stack === 0 ? ' (オールイン)' : ''}`);
    } else {
      return;
    }

    p.acted = true;
    this.clearTurnTimer();
    this.afterAction();
  }

  afterAction() {
    const live = this.livePlayers();
    if (live.length === 1) return this.endHandFold(live[0]);

    const next = this.nextIndex(this.actingIndex, (p) => this.canActNow(p));
    if (next !== -1) {
      this.actingIndex = next;
      this.setTurnTimer();
      this.broadcast();
    } else {
      this.nextStreet();
    }
  }

  nextStreet() {
    for (const p of this.players) {
      p.betStreet = 0;
      p.acted = false;
    }
    this.currentBet = 0;
    this.minRaise = this.config.bb;
    this.actingIndex = -1;

    if (this.phase === 'river') return this.showdown();

    if (this.phase === 'preflop') {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else if (this.phase === 'flop') {
      this.board.push(this.deck.pop());
      this.phase = 'turn';
    } else {
      this.board.push(this.deck.pop());
      this.phase = 'river';
    }
    this.log(`${phaseLabel(this.phase)}: ${this.board.map(cardText).join(' ')}`);

    const canAct = this.livePlayers().filter((p) => p.stack > 0);
    if (canAct.length < 2) {
      // 全員オールイン: 手札を公開して最後まで配り切る
      for (const p of this.livePlayers()) p.revealed = true;
      this.broadcast();
      return this.delay(() => this.nextStreet(), 1400);
    }
    this.actingIndex = this.nextIndex(this.dealerIndex, (p) => this.canActNow(p));
    if (this.actingIndex === -1) return this.nextStreet();
    this.setTurnTimer();
    this.broadcast();
  }

  // ---- 決着 ----

  returnUncalled() {
    const inH = this.players.filter((p) => p.inHand);
    if (inH.length < 2) return;
    const sorted = [...inH].sort((a, b) => b.committed - a.committed);
    const diff = sorted[0].committed - sorted[1].committed;
    if (diff > 0 && !sorted[0].folded) {
      sorted[0].committed -= diff;
      sorted[0].stack += diff;
    }
  }

  endHandFold(winner) {
    this.clearTurnTimer();
    this.returnUncalled();
    const pot = this.players.reduce((s, p) => s + p.committed, 0);
    winner.stack += pot;
    for (const p of this.players) { p.committed = 0; p.betStreet = 0; }
    this.phase = 'showdown';
    this.actingIndex = -1;
    const line = `${winner.name} がポット ${fmt(pot)} を獲得`;
    this.lastResult = { lines: [line] };
    this.log(line);
    this.broadcast();
    this.scheduleNextHand(NEXT_HAND_MS);
  }

  buildPots() {
    const contrib = new Map(this.players.map((p) => [p, p.committed]));
    const pots = [];
    for (let guard = 0; guard < 50; guard++) {
      const contenders = this.players.filter(
        (p) => p.inHand && !p.folded && contrib.get(p) > 0,
      );
      if (!contenders.length) break;
      const level = Math.min(...contenders.map((p) => contrib.get(p)));
      let amount = 0;
      for (const p of this.players) {
        const c = contrib.get(p);
        if (c > 0) {
          const take = Math.min(c, level);
          contrib.set(p, c - take);
          amount += take;
        }
      }
      pots.push({ amount, eligible: contenders });
    }
    // 万一の残額は最後のポットへ
    const leftover = [...contrib.values()].reduce((s, v) => s + v, 0);
    if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  showdown() {
    this.clearTurnTimer();
    this.phase = 'showdown';
    this.actingIndex = -1;
    this.returnUncalled();
    const pots = this.buildPots();
    const live = this.livePlayers();
    for (const p of live) {
      p.revealed = true;
      p.result = evaluate7([...p.cards, ...this.board]);
    }
    const lines = [];
    pots.forEach((pot, i) => {
      const best = Math.max(...pot.eligible.map((p) => p.result.score));
      const winners = pot.eligible.filter((p) => p.result.score === best);
      const share = Math.floor(pot.amount / winners.length);
      let rem = pot.amount - share * winners.length;
      for (const w of winners) {
        let got = share;
        if (rem > 0) { got++; rem--; }
        w.stack += got;
      }
      const label = pots.length === 1 ? 'ポット' : i === 0 ? 'メインポット' : `サイドポット${i}`;
      lines.push(`${winners.map((w) => w.name).join('、')} が${label} ${fmt(pot.amount)} を獲得 (${winners[0].result.name})`);
    });
    for (const p of this.players) { p.committed = 0; p.betStreet = 0; }
    this.lastResult = { lines };
    for (const l of lines) this.log(l);
    this.broadcast();
    this.scheduleNextHand(NEXT_HAND_MS);
  }

  // ---- タイマー ----

  delay(fn, ms) {
    if (this.fastMode) return fn();
    setTimeout(fn, ms);
  }

  scheduleNextHand(ms) {
    if (this.fastMode) return; // テスト時は手動で startHand を呼ぶ
    this.clearNextHandTimer();
    this.nextHandTimer = setTimeout(() => this.startHand(), ms);
  }

  clearNextHandTimer() {
    if (this.nextHandTimer) { clearTimeout(this.nextHandTimer); this.nextHandTimer = null; }
  }

  setTurnTimer() {
    this.clearTurnTimer();
    if (this.fastMode) return;
    const p = this.players[this.actingIndex];
    const limit = p && !p.connected ? TURN_LIMIT_DISCONNECTED_MS : TURN_LIMIT_MS;
    this.turnDeadline = Date.now() + limit;
    this.turnTimer = setTimeout(() => this.autoAct(), limit);
  }

  clearTurnTimer() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    this.turnDeadline = null;
  }

  autoAct() {
    const p = this.players[this.actingIndex];
    if (!p || !BETTING_PHASES.includes(this.phase)) return;
    this.log(`${p.name} は時間切れ`);
    if (this.currentBet > p.betStreet) this.handleAction(p.token, 'fold');
    else this.handleAction(p.token, 'check');
  }

  destroy() {
    this.clearTurnTimer();
    this.clearNextHandTimer();
  }

  // ---- ユーティリティ ----

  nextIndex(from, pred) {
    const n = this.players.length;
    if (!n) return -1;
    for (let i = 1; i <= n; i++) {
      const idx = ((from < 0 ? -1 : from) + i + n) % n;
      if (pred(this.players[idx])) return idx;
    }
    return -1;
  }

  log(msg) {
    this.logs.push(msg);
    if (this.logs.length > 100) this.logs.shift();
    if (!this.fastMode) this.io.to(this.code).emit('log', msg);
  }

  sendError(p, msg) {
    if (!this.fastMode) this.io.to(p.socketId).emit('errorMsg', msg);
  }

  // ---- 状態送信 ----

  broadcast() {
    if (this.fastMode) return;
    for (const p of this.players) {
      if (p.connected) this.io.to(p.socketId).emit('state', this.stateFor(p));
    }
  }

  stateFor(me) {
    const pot = this.players.reduce((s, p) => s + p.committed, 0);
    const yourTurn = BETTING_PHASES.includes(this.phase)
      && this.players[this.actingIndex] === me;
    let turn = null;
    if (yourTurn) {
      const toCall = Math.min(this.currentBet - me.betStreet, me.stack);
      const maxTo = me.betStreet + me.stack;
      let minTo = this.currentBet === 0 ? this.config.bb : this.currentBet + this.minRaise;
      minTo = Math.min(minTo, maxTo);
      const diff = this.currentBet - me.betStreet;
      const potRaiseTo = Math.min(this.currentBet + pot + diff, maxTo);
      const halfPotRaiseTo = Math.min(this.currentBet + Math.round((pot + diff) / 2), maxTo);
      turn = {
        toCall,
        canCheck: toCall <= 0,
        canRaise: maxTo > this.currentBet && me.stack > Math.max(toCall, 0),
        minRaiseTo: minTo,
        maxRaiseTo: maxTo,
        potRaiseTo: Math.max(potRaiseTo, minTo),
        halfPotRaiseTo: Math.max(halfPotRaiseTo, minTo),
      };
    }
    return {
      code: this.code,
      config: this.config,
      phase: this.phase,
      board: this.board,
      handNumber: this.handNumber,
      started: this.handNumber > 0,
      pot,
      currentBet: this.currentBet,
      deadline: this.turnDeadline,
      isHost: me.token === this.hostToken,
      lastResult: this.phase === 'showdown' ? this.lastResult : null,
      turn,
      players: this.players.map((p, i) => ({
        name: p.name,
        stack: p.stack,
        bet: p.betStreet,
        folded: p.folded,
        inHand: p.inHand,
        sittingOut: p.sittingOut,
        connected: p.connected,
        dealer: i === this.dealerIndex && this.phase !== 'waiting',
        acting: i === this.actingIndex && BETTING_PHASES.includes(this.phase),
        you: p === me,
        cards: p === me || p.revealed ? p.cards : null,
        hasCards: p.inHand && !p.folded,
        profit: p.stack + p.committed + p.pendingAdd + p.banked - p.totalBuyIn,
        pendingAdd: p.pendingAdd,
        pendingReturn: p.pendingReturn,
        banked: p.banked,
        handName: p.revealed && p.result ? p.result.name : null,
      })),
    };
  }
}

const SUIT_CH = ['♠', '♥', '♦', '♣'];
function cardText(c) {
  const r = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[c.r] || String(c.r);
  return SUIT_CH[c.s] + r;
}

function phaseLabel(ph) {
  return { flop: 'フロップ', turn: 'ターン', river: 'リバー' }[ph] || ph;
}

function fmt(n) {
  return n.toLocaleString('ja-JP');
}

module.exports = Table;
