// ゲームエンジンのシミュレーションテスト
// ランダムなアクションで大量のハンドを回し、チップ総量の保存などの不変条件を検証する

const assert = require('assert');
const Table = require('../game/table');

const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {} };

function totalChips(t) {
  return t.players.reduce((s, p) => s + p.stack + p.committed + p.pendingAdd + p.banked, 0);
}
function totalBuyIn(t) {
  return t.players.reduce((s, p) => s + p.totalBuyIn + p.pendingAdd, 0);
}

function randomAction(t) {
  const p = t.players[t.actingIndex];
  const toCall = t.currentBet - p.betStreet;
  const maxTo = p.betStreet + p.stack;
  let minTo = t.currentBet === 0 ? t.config.bb : t.currentBet + t.minRaise;
  minTo = Math.min(minTo, maxTo);
  const r = Math.random();

  if (toCall > 0) {
    if (r < 0.25) return ['fold'];
    if (r < 0.75 || maxTo <= t.currentBet) return ['call'];
    const to = minTo + Math.floor(Math.random() * (maxTo - minTo + 1));
    return ['raise', to];
  }
  if (r < 0.65) return ['check'];
  const to = minTo + Math.floor(Math.random() * (maxTo - minTo + 1));
  return ['raise', to];
}

function runGame(numPlayers, hands, seedLabel) {
  const t = new Table(fakeIo, 'TEST', { sb: 50, bb: 100, buyIn: 10000 });
  t.fastMode = true;
  for (let i = 0; i < numPlayers; i++) t.addPlayer(`P${i + 1}`, `tok${i}`, `sock${i}`);

  t.startHand();
  let guard = 0;
  const GUARD_MAX = 500000;

  while (t.handNumber < hands && guard++ < GUARD_MAX) {
    assert.strictEqual(
      totalChips(t), totalBuyIn(t),
      `[${seedLabel}] hand ${t.handNumber} phase ${t.phase}: チップ総量が合わない`,
    );
    for (const p of t.players) {
      assert.ok(p.stack >= 0, `[${seedLabel}] ${p.name} のスタックが負`);
      assert.ok(p.committed >= 0, `[${seedLabel}] ${p.name} のcommittedが負`);
    }

    if (t.phase === 'waiting') {
      // 飛んだプレイヤーをリバイさせて続行
      for (const p of t.players) if (p.stack === 0) t.addChips(p.token, 10000);
      t.startHand();
      continue;
    }
    if (t.phase === 'showdown') {
      // 30%でリバイ
      for (const p of t.players) {
        if (p.stack === 0 && Math.random() < 0.3) t.addChips(p.token, 10000);
      }
      t.startHand();
      continue;
    }
    assert.ok(t.actingIndex >= 0, `[${seedLabel}] betting中なのに手番がいない (phase=${t.phase})`);
    const [type, amount] = randomAction(t);
    const before = JSON.stringify([t.actingIndex, t.phase, t.currentBet,
      t.players.map((p) => [p.stack, p.betStreet, p.acted, p.folded])]);
    t.handleAction(t.players[t.actingIndex].token, type, amount);
    const after = JSON.stringify([t.actingIndex, t.phase, t.currentBet,
      t.players.map((p) => [p.stack, p.betStreet, p.acted, p.folded])]);
    assert.notStrictEqual(before, after, `[${seedLabel}] アクション ${type} ${amount} で状態が変化しない`);
  }
  assert.ok(guard < GUARD_MAX, `[${seedLabel}] 無限ループの疑い`);
  console.log(`OK: ${numPlayers}人 × ${hands}ハンド (${seedLabel})`);
}

// 役判定の単体チェック
const { evaluate7 } = require('../game/evaluator');
function c(r, s) { return { r, s }; }

const flop = [c(2, 0), c(7, 1), c(9, 2)];
const royal = evaluate7([c(14, 0), c(13, 0), c(12, 0), c(11, 0), c(10, 0), ...flop.slice(0, 2)]);
assert.strictEqual(royal.name, 'ロイヤルフラッシュ');
const wheel = evaluate7([c(14, 0), c(2, 1), c(3, 2), c(4, 3), c(5, 0), c(9, 1), c(13, 2)]);
assert.strictEqual(wheel.name, 'ストレート');
const quads = evaluate7([c(8, 0), c(8, 1), c(8, 2), c(8, 3), c(5, 0), c(9, 1), c(13, 2)]);
assert.strictEqual(quads.name, 'フォーカード');
const fh = evaluate7([c(8, 0), c(8, 1), c(8, 2), c(5, 3), c(5, 0), c(9, 1), c(13, 2)]);
assert.strictEqual(fh.name, 'フルハウス');
const twoPair = evaluate7([c(8, 0), c(8, 1), c(5, 2), c(5, 3), c(2, 0), c(9, 1), c(13, 2)]);
assert.strictEqual(twoPair.name, 'ツーペア');
// キッカー勝負: A高フラッシュ > K高フラッシュ
const fA = evaluate7([c(14, 0), c(9, 0), c(7, 0), c(4, 0), c(2, 0), c(3, 1), c(6, 2)]);
const fK = evaluate7([c(13, 0), c(9, 0), c(7, 0), c(4, 0), c(2, 0), c(3, 1), c(6, 2)]);
assert.ok(fA.score > fK.score);
console.log('OK: 役判定');

// チップ戻し(確定ポイント)のテスト
{
  const t = new Table(fakeIo, 'RET', { sb: 50, bb: 100, buyIn: 10000, maxBuyIn: 10000 });
  t.fastMode = true;
  t.addPlayer('X', 'tx', 'sx');
  t.addPlayer('Y', 'ty', 'sy');
  // X が 6,000 勝った状態を再現
  t.players[0].stack = 16000;
  t.players[1].stack = 4000;

  t.returnChips('tx', 7000); // 余剰6,000を超えるので拒否される
  assert.strictEqual(t.players[0].stack, 16000, '余剰超の戻しは拒否');
  t.returnChips('tx', 6000); // 待機中なので即時反映
  assert.strictEqual(t.players[0].stack, 10000, '戻し後のスタック');
  assert.strictEqual(t.players[0].banked, 6000, '確定分');
  const v = t.stateFor(t.players[0]).players.find((p) => p.you);
  assert.strictEqual(v.profit, 6000, 'ポイントに確定分が反映される');

  // ハンド中は予約になり、次ハンド開始時に余剰の範囲で反映される
  // (X がさらに 3,000 勝った状態を再現)
  t.players[0].stack = 13000;
  t.players[1].stack = 1000;
  t.startHand();
  t.returnChips('tx', 2500); // ブラインド支払い後の余剰の範囲内
  assert.strictEqual(t.players[0].pendingReturn, 2500, 'ハンド中は予約');
  const actor = t.players[t.actingIndex];
  t.handleAction(actor.token, 'fold'); // ヘッズアップなので即ハンド終了
  t.startHand();
  const x = t.players.find((p) => p.token === 'tx');
  assert.ok(x.pendingReturn === 0, '予約が消化される');
  assert.ok(x.stack >= 10000 - t.config.bb && x.banked >= 8400, '余剰の範囲で確定');
  assert.strictEqual(totalChips(t), totalBuyIn(t), '戻し後もチップ総量が保存される');
  console.log('OK: チップ戻し(確定ポイント)');
}

for (let i = 0; i < 5; i++) runGame(4, 300, `run${i + 1}`);
runGame(2, 300, 'ヘッズアップ');
runGame(6, 200, '6人');

console.log('\nすべてのテストに合格しました ✓');
