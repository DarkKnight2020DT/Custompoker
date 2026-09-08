import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFive, evaluateLowFive, bestHigh, bestLow } from '../server/evaluator.js';

const c=s=>[...s.matchAll(/(10|[2-9TJQKA])([shdc])/g)].map(m=>({rank:m[1]==='10'?'T':m[1],suit:m[2]}));

test('high evaluator orders straight flush above quads',()=>{
  const sf=evaluateFive(c('AsKsQsJsTs'));
  const q=evaluateFive(c('AhAdAcAs2d'));
  assert.equal(sf.name,'Royal Flush');
  assert.ok(sf.score[0]>q.score[0]);
});

test('wheel straight is recognized',()=>{
  const e=evaluateFive(c('As2h3d4c5s'));
  assert.equal(e.name,'Straight');
  assert.deepEqual(e.score,[4,5]);
});

test('omaha requires exactly two hole cards and three board cards',()=>{
  const hole=c('AsKd2c3c');
  const board=c('QsJsTs9d8d');
  const h=bestHigh(hole,board,'omaha');
  assert.equal(h.name,'Straight');
  assert.notEqual(h.name,'Royal Flush');
});

test('custom low has no qualifier and prefers a weak high-card hand over a wheel straight',()=>{
  const hole=c('As2dKhQc');
  const board=c('3c4h5s9dTd');
  const low=bestLow(hole,board,'omaha');
  assert.ok(low);
  assert.equal(low.name,'High Card');
  assert.deepEqual(low.score,[0,9,4,3,2,1]);
});

test('A-2-3-4-6 is better low than A-2-3-4-5 because the latter is a straight',()=>{
  const six=evaluateLowFive(c('As2h3d4c6s'));
  const five=evaluateLowFive(c('As2h3d4c5s'));
  assert.equal(six.name,'High Card');
  assert.equal(five.name,'Straight');
  assert.ok(six.score[0] < five.score[0]);
});

test('custom Omaha low matches QQ55A + 234A example',()=>{
  const low=bestLow(c('2s3h4dAc'),c('QsQh5d5cAs'),'omaha');
  assert.equal(low.name,'High Card');
  assert.deepEqual(low.score,[0,12,5,3,2,1]);
});

test('custom Omaha low can use hole ace to cover board ace with QQ23A + KKA4',()=>{
  const low=bestLow(c('KsKhAc4d'),c('QsQh2d3cAs'),'omaha');
  assert.equal(low.name,'High Card');
  assert.deepEqual(low.score,[0,12,4,3,2,1]);
});
