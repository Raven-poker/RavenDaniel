// 実Socket.IO通信での統合テスト:
// 3人プレイ中に1人が切断 → 残りでゲーム続行(短縮タイマーで自動フォールド)
// → 切断した人が別端末(新トークン)から同名で席に復帰できること

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3199;
const URL = `http://localhost:${PORT}`;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function connect(name) {
  const s = io(URL, { forceNew: true });
  const c = { name, s, state: null, lastActed: 0 };
  s.on('state', (st) => {
    c.state = st;
    // 自分の手番なら自動でチェック/コール(実際のプレイヤーの動きを再現)
    if (st.turn && Date.now() - c.lastActed > 250) {
      c.lastActed = Date.now();
      setTimeout(() => {
        s.emit('action', { type: st.turn.canCheck ? 'check' : 'call' });
      }, 300);
    }
  });
  return c;
}

function emitAck(s, ev, data) {
  return new Promise((r) => s.emit(ev, data, r));
}

async function waitFor(fn, label, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return;
    await wait(200);
  }
  throw new Error(`タイムアウト: ${label}`);
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  await wait(800);

  try {
    // 3人参加 (バイイン上限 10000)
    const a = connect('あき');
    const resA = await emitAck(a.s, 'createRoom', {
      name: 'あき', token: 'tok-a', buyIn: 10000, maxBuyIn: 10000,
    });
    assert.ok(resA.ok, 'ルーム作成');
    const code = resA.code;

    // バイイン上限: 初期持ち点10000の状態では1点も追加できない
    let lastError = null;
    a.s.on('errorMsg', (m) => { lastError = m; });
    a.s.emit('addChips', 1);
    await waitFor(() => lastError, '上限超過エラーの受信');
    assert.ok(lastError.includes('上限'), `上限エラーメッセージ: ${lastError}`);
    await waitFor(() => a.state && a.state.players[0].stack === 10000, '持ち点が増えていない');
    console.log(`OK: バイイン上限 (${lastError})`);
    lastError = null;

    const b = connect('ぼん');
    const resB = await emitAck(b.s, 'joinRoom', { name: 'ぼん', code, token: 'tok-b' });
    assert.ok(resB.ok, 'B参加');
    const c = connect('ちこ');
    const resC = await emitAck(c.s, 'joinRoom', { name: 'ちこ', code, token: 'tok-c' });
    assert.ok(resC.ok, 'C参加');

    // 開始
    a.s.emit('startGame');
    const clients = [a, b, c];
    await waitFor(() => clients.every((x) => x.state && x.state.phase === 'preflop'),
      'ハンド開始');

    // スタンプ: 送信→全員に配信、クールダウン中の連打は無視
    const stamps = [];
    a.s.on('stamp', (d) => stamps.push(d));
    b.s.emit('sendStamp', 0);
    await waitFor(() => stamps.length === 1, 'スタンプ受信');
    assert.strictEqual(stamps[0].name, 'ぼん');
    assert.strictEqual(stamps[0].stamp, '🔥');
    b.s.emit('sendStamp', 1); // 2秒以内の連打
    b.s.emit('sendStamp', 99); // 不正なインデックス
    await wait(800);
    assert.strictEqual(stamps.length, 1, '連打と不正値は無視される');
    console.log('OK: スタンプ送受信とクールダウン');

    // いま手番のプレイヤーを切断させる
    await waitFor(() => clients.some((x) => x.state.turn), '手番の発生');
    const dropped = clients.find((x) => x.state.turn);
    const rest = clients.filter((x) => x !== dropped);
    console.log(`切断テスト: ${dropped.name} (手番) を切断`);
    dropped.s.disconnect();

    // 切断中タイマー(15秒)で自動フォールドされ、ゲームが進むこと
    await waitFor(() => rest.every((x) => {
      const me = x.state.players.find((p) => p.name === dropped.name);
      return me && !me.connected && (me.folded || !me.inHand || x.state.phase !== 'preflop');
    }), '切断プレイヤーの自動フォールドと進行', 25000);
    console.log('OK: 切断後もゲームが進行(自動フォールド)');

    // 残り2人でハンドが完了し、次のハンドが始まること
    // (切断者がチェックで回せる場合は1ストリート15秒ずつ消化されるため長めに待つ)
    await waitFor(() => rest.some((x) => x.state.handNumber >= 2),
      '残り2人での次ハンド開始', 90000);
    console.log('OK: 残り2人で次のハンドが自動開始');

    // 別端末(新トークン)から同名で復帰
    const stackBefore = rest[0].state.players.find((p) => p.name === dropped.name).stack;
    const re = connect(dropped.name);
    const resRe = await emitAck(re.s, 'joinRoom', { name: dropped.name, code, token: 'tok-new-device' });
    assert.ok(resRe.ok, '同名復帰が許可される');
    await waitFor(() => re.state, '復帰後のstate受信');
    const meAfter = re.state.players.find((p) => p.you);
    assert.strictEqual(meAfter.name, dropped.name, '同じ席に戻る');
    assert.strictEqual(meAfter.stack, stackBefore, 'スタックが保持される');
    assert.strictEqual(re.state.players.length, 3, '席が増えていない');
    console.log(`OK: ${dropped.name} が別端末から復帰 (スタック ${meAfter.stack} 保持)`);

    // 接続中の名前では入れないこと
    const dup = connect('偽者');
    const resDup = await emitAck(dup.s, 'joinRoom', { name: rest[0].name, code, token: 'tok-evil' });
    assert.ok(resDup.error, '接続中の同名参加は拒否される');
    console.log('OK: 接続中プレイヤーの名前は乗っ取れない');

    // 復帰した人が次ハンドに配られること
    await waitFor(() => {
      const me = re.state && re.state.players.find((p) => p.you);
      return me && me.inHand;
    }, '復帰プレイヤーが次ハンドに参加', 30000);
    console.log('OK: 復帰後のハンドに参加');

    [a, b, c, re, dup].forEach((x) => x.s.close());
    console.log('\n統合テスト: すべて合格 ✓');
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
