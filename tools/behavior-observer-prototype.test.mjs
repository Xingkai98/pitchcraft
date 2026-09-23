import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateEndTime, observeMatch, zoneFor } from './behavior-observer-prototype.mjs';

const event = (patch) => ({ t: 0, type: 'pass', subject: 5, from: 5, to: 6, x: 0.2, y: 0.5, x2: 0.4, y2: 0.5, result: 'success', speed: 10, ...patch });

test('zoneFor respects each team attack direction', () => {
  assert.equal(zoneFor('home', 0.8), 'final_third');
  assert.equal(zoneFor('away', 0.2), 'final_third');
  assert.equal(zoneFor('home', 0.5), 'middle_third');
});

test('estimateEndTime uses event flight geometry', () => {
  assert.equal(estimateEndTime(event()), 2.1);
  assert.equal(estimateEndTime(event({ speed: 0 })), 0);
});

test('successful pass stays in one possession', () => {
  const result = observeMatch([event(), event({ t: 3, subject: 6, from: 6, to: 7, x: 0.4, x2: 0.6 })]);
  assert.equal(result.possessions.length, 1);
  assert.equal(result.possessions[0].actions.length, 2);
});

test('interception changes possession and marks control change', () => {
  const result = observeMatch([
    event(),
    event({ t: 3, subject: 18, from: 5, to: 6, x: 0.4, x2: 0.5, result: 'intercepted' }),
    { t: 4, type: 'pass', subject: 18, from: 18, to: 19, x: 0.5, y: 0.5, x2: 0.6, y2: 0.5, result: 'success', speed: 10 },
  ]);
  assert.equal(result.possessions.length, 2);
  assert.equal(result.observations[1].possession_change, 'lost');
  assert.equal(result.possessions[1].team, 'away');
});

test('lost pass remains contested until a team controls the next action', () => {
  const result = observeMatch([
    event({ result: 'lost' }),
    event({ t: 4, subject: 7, from: 7, to: 8, x: 0.3, x2: 0.4 }),
  ]);
  assert.equal(result.possessions.length, 1);
  assert.equal(result.observations[0].possession_change, 'contested');
});

test('foul closes play and the next free kick can start a new segment', () => {
  const result = observeMatch([
    { t: 1, type: 'foul', subject: 15, carrier: 6, x: 0.4, y: 0.5, detail: 'foul_trip' },
    { t: 2, type: 'pass', subject: 6, from: 6, to: 7, x: 0.4, y: 0.5, x2: 0.5, y2: 0.5, result: 'success', detail: 'free_kick', speed: 10 },
  ]);
  assert.equal(result.possessions.length, 2);
  assert.equal(result.possessions[0].end_reason, 'foul_restart');
  assert.equal(result.possessions[1].actions[0].phase, 'set_piece');
});
