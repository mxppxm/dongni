import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCompanionPresentation as present, getCompanionMotion as motion } from '../lib/companion-state.ts';

const task = (overrides = {}) => ({ id: 1, kind: 'super', status: 'running', stage: 'working', ...overrides });
const reply = { key: 'reply:2', status: 'waiting', mood: 'comfort' };
const success = { state: 'success', activityKey: 'task:0' };

test('a task awaiting an answer takes precedence over chat and completion feedback', () => {
  assert.deepEqual(present({ tasks: [task({ stage: 'asking' })], reply, feedback: success }), {
    state: 'confused', label: '等你回答', activityKey: 'task:1',
  });
});
test('pending replies retain their own mood and never show stale success', () => {
  assert.deepEqual(present({ reply, feedback: success, typing: true }), {
    state: 'thinking', label: '让我想想', mood: 'comfort', activityKey: 'reply:2',
  });
  assert.equal(present({ sending: true, feedback: success }).state, 'thinking');
  assert.equal(present({ reply: { ...reply, status: 'streaming' } }).state, 'speaking');
});
test('remaining work hides completion and typing; queue and stalled tasks are explicit', () => {
  assert.equal(present({ tasks: [task()], feedback: success, typing: true }).state, 'working');
  assert.equal(present({ tasks: [task({ stage: 'queued' })] }).label, '排队等开工');
  assert.equal(present({ tasks: [task({ live: { idleSec: 120 } })] }).state, 'confused');
  assert.equal(present({ tasks: [task({ live: { idleSec: 119 } })] }).state, 'working');
  assert.equal(present({ tasks: [task(), task({ id: 2 })] }).label, '2 件事正在忙');
  assert.equal(present({ tasks: [task({ kind: 'generate_image' })] }).mood, 'draw');
  assert.equal(present({ tasks: [task({ kind: 'create_mood' })] }).mood, 'draw');
});
test('historical completed tasks do not produce success on page load', () => {
  assert.deepEqual(present({ tasks: [task({ status: 'done' }), task({ id: 2, status: 'error' })] }), { state: 'idle' });
});
test('feedback is shown after work ends, followed by input or idle', () => {
  const failure = { state: 'failure', activityKey: 'task:1' };
  assert.deepEqual(present({ feedback: failure }), failure);
  assert.deepEqual(present({ feedback: success }), success);
  assert.equal(present({ typing: true }).state, 'typing');
  assert.equal(present({ tasks: null }).state, 'idle');
});
test('base and custom moods express feelings without completing pending work', () => {
  assert.deepEqual(motion('thinking', { key: 'comfort', name: '陪着', preset: 'breathe', fx: 'hearts' }), { action: 'love', waiting: 'spin' });
  assert.deepEqual(motion('working', { key: 'custom-art', name: '画画', preset: 'scribble', fx: 'line' }), { action: 'inspect', waiting: 'wave' });
  assert.deepEqual(motion('thinking', { key: 'run', name: '跑腿', preset: 'stride', fx: 'wind' }), { action: 'idle', waiting: 'wrap' });
  assert.equal(motion('speaking', { key: 'cheer', name: '开心', preset: 'jump', fx: 'sparks' }).action, 'surprise');
  assert.equal(motion('success', { key: 'wave', name: '招手', preset: 'hi', fx: 'none' }).action, 'affirm');
  assert.deepEqual(motion('thinking', { key: 'unknown', name: '新心情', preset: 'float', fx: 'none' }), { action: 'idle', waiting: 'spin' });
});
test('failure, confirmation and input cannot be overridden by a cheerful mood', () => {
  const cheerful = { key: 'cheer', name: '开心', preset: 'jump', fx: 'sparks' };
  assert.deepEqual(motion('failure', cheerful), { action: 'failure' });
  assert.deepEqual(motion('confused', cheerful), { action: 'wary' });
  assert.deepEqual(motion('typing', cheerful), { action: 'input' });
});
