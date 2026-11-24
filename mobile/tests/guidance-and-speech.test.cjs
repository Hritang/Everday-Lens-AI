const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const { AlignmentTracker, canAnnounce, framingFailure, guidanceProgress, progressionMessage,
  VisionHints } = require('../src/camera/alignmentGuidance.ts');
const selection = require('../src/voice/voiceSelection.ts');

const frame = {
  ready: true, direction: 'ready', message: 'The frame is clear.',
  metrics: {
    center_x: 0.5, center_y: 0.5, area_ratio: 0.4, tilt_degrees: 0, sharpness: 54,
    corners: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]],
  },
};

test('readiness requires three sharp, similar frames and expires when sampling pauses', () => {
  const tracker = new AlignmentTracker();
  assert.equal(tracker.observe(frame, 1000).result.ready, false);
  assert.equal(tracker.observe(frame, 1280).result.ready, false);
  assert.equal(tracker.observe(frame, 1560).result.message, 'Alignment fixed. Document ready. Say capture.');
  assert.equal(tracker.observe(frame, 2600).result.ready, false);
});

test('creeping motion and alternating detections do not announce readiness or premature directions', () => {
  const tracker = new AlignmentTracker();
  const shifted = x => ({ ...frame, metrics: { ...frame.metrics, center_x: frame.metrics.center_x + x,
    corners: frame.metrics.corners.map(([cx, cy]) => [cx + x, cy]) } });
  assert.equal(tracker.observe(frame, 1000).result.ready, false);
  assert.equal(tracker.observe(shifted(0.021), 1280).result.ready, false);
  assert.equal(tracker.observe(shifted(0.042), 1560).result.ready, false);
  const correction = { ...frame, ready: false, direction: 'move_left' };
  assert.equal(tracker.observe(correction, 1840).confirmed, false);
  assert.equal(tracker.observe({ ...correction, direction: 'move_right' }, 2120).confirmed, false);
  assert.equal(tracker.observe(correction, 2400).confirmed, false);
  assert.equal(tracker.observe(correction, 2680).confirmed, true);
  assert.equal(canAnnounce('move_left', 'move_left', 9999), false);
  assert.equal(canAnnounce('move_left', 'move_left', 10000), true);
  assert.equal(canAnnounce('ready', 'ready', 60000), false);
});

test('diagonal jitter retains a correction until another axis clearly dominates', () => {
  const tracker = new AlignmentTracker();
  const positioned = (x, y, direction, ready = false) => ({
    ...frame, ready, direction, metrics: { ...frame.metrics, center_x: x, center_y: y },
  });
  assert.equal(tracker.observe(positioned(0.38, 0.40, 'move_left'), 1000).result.direction, 'move_left');
  assert.equal(tracker.observe(positioned(0.4, 0.38, 'move_up'), 1270).result.direction, 'move_left');
  assert.equal(tracker.observe(positioned(0.41, 0.33, 'move_up'), 1540).confirmed, false);
  const next = tracker.observe(positioned(0.42, 0.35, 'move_up'), 1810);
  assert.equal(next.result.direction, 'move_up');
  assert.equal(next.confirmed, true);
  assert.equal(tracker.observe(positioned(0.45, 0.429, 'ready', true), 2080).result.direction, 'move_up');
  assert.equal(tracker.observe(positioned(0.46, 0.452, 'ready', true), 2350).result.direction, 'stabilize');
});

test('progress can prompt a short reminder without repeating on small movement', () => {
  assert.equal(guidanceProgress(0.22, 0.17), true);
  assert.equal(guidanceProgress(0.22, 0.20), false);
  assert.equal(guidanceProgress(0.22, 0.24), false);
  assert.equal(progressionMessage('move_left'), 'A little more left.');
  assert.equal(canAnnounce('move_left', 'move_left', 1249, true), false);
  assert.equal(canAnnounce('move_left', 'move_left', 1250, true), true);
});

test('framing errors give different recovery cues for camera, connection and backend failures', () => {
  assert.match(framingFailure('portrait'), /sideways.*upright/);
  assert.match(framingFailure('camera'), /camera sample.*retry/);
  assert.match(framingFailure('connection'), /reach the framing service.*connection/);
  assert.match(framingFailure('timeout'), /slow.*retry/);
  assert.match(framingFailure('server'), /process the sample.*retry/);
});

test('Gemini must give two timely matching hints and cannot override local geometry', () => {
  const hints = new VisionHints();
  const left = { detected: true, ready: false, direction: 'move_left' };
  const right = { ...left, direction: 'move_right' };
  const observe = (result, sample, now = sample + 1600, geometry = 0) => {
    hints.observe(result, sample, now, geometry, 10000);
    return hints.current(now)?.result.direction;
  };
  assert.equal(observe(left, 1000), undefined);
  assert.equal(observe(right, 4000), undefined);
  assert.equal(observe(right, 7000), 'move_right');
  assert.equal(observe(right, 10000, 11600, 11000), undefined);
  assert.equal(observe(left, 13000, 20200), undefined);
  assert.equal(observe(left, 19000), undefined);
  assert.equal(observe(left, 22000), 'move_left');
  assert.equal(hints.current(29200), null);
  assert.equal(observe({ ...left, ready: true, direction: 'ready' }, 28000), undefined);
});

const preferred = { identifier: 'en-in-x-ahp-local', name: 'en-in-x-ahp-local', language: 'en-IN', quality: 'Default' };
test('selects the preferred installed English voice and has graceful alternatives', () => {
  const enhanced = { identifier: 'en-us-x-iol-local', name: 'en-us-x-iol-local', language: 'en-US', quality: 'Enhanced' };
  const network = { ...preferred, identifier: 'en-in-x-ahp-network' };
  assert.equal(selection.chooseEnglishVoice([enhanced, network, preferred]), preferred);
  assert.equal(selection.chooseEnglishVoice([enhanced, network]), enhanced);
  assert.equal(selection.chooseEnglishVoice([network]), undefined);
  assert.deepEqual(selection.speechChunks('Total 45.00. Please read the next line when ready.', 26),
    ['Total 45.00.', 'Please read the next line', 'when ready.']);
});

function speechHarness() {
  const calls = [];
  const speech = {
    maxSpeechInputLength: 4000,
    getAvailableVoicesAsync: async () => [preferred],
    speak: (text, options) => calls.push({ text, options }),
    stop: async () => {},
  };
  const react = { useRef: current => ({ current }), useState: initial => [initial, () => {}], useEffect: () => {} };
  const file = path.join(__dirname, '../src/voice/speechOutput.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
  const exports = {};
  const stubs = { 'expo-speech': speech, react, './voiceSelection': selection };
  vm.runInNewContext(outputText, {
    exports, require: name => stubs[name], setTimeout, clearTimeout, console: { info: () => {} },
  });
  return { calls, output: exports.useSpeechOutput() };
}

const cycle = () => new Promise(resolve => setImmediate(resolve));
test('guidance waits for microphone release and speech never interrupts a current phrase', async () => {
  const { calls, output } = speechHarness();
  let release;
  const guide = output.speak('Move your phone slightly left.', true,
    () => new Promise(resolve => { release = resolve; }));
  await cycle();
  assert.equal(calls.length, 0);
  release(true);
  await cycle();
  const response = output.speak('AI description ready.');
  await cycle();
  assert.equal(calls.length, 1);
  calls[0].options.onStart();
  calls[0].options.onDone();
  await cycle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.voice, preferred.identifier);
  calls[1].options.onDone();
  await Promise.all([guide, response]);
  assert.equal(output.speaking.current, false);
});

test('an unavailable installed voice falls back before playback begins', async () => {
  const { calls, output } = speechHarness();
  const spoken = output.speak('Welcome to Everyday Lens.');
  await cycle();
  assert.equal(calls[0].options.voice, preferred.identifier);
  calls[0].options.onError();
  await cycle();
  assert.equal(calls[1].options.voice, undefined);
  calls[1].options.onDone();
  assert.equal(await spoken, true);
  assert.equal(output.speaking.current, false);
});

test('interrupting a spoken disclosure reports that playback did not complete', async () => {
  const { calls, output } = speechHarness();
  const disclosure = output.speak('Small framing samples go to Google Gemini.');
  await cycle();
  calls[0].options.onStart();
  await output.stop();
  assert.equal(await disclosure, false);
});
