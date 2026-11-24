import { requireOptionalNativeModule } from 'expo';
import { File } from 'expo-file-system';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { authorization, checkLiveAccess, getServer } from '../api/serverAccess';
import type { VoiceCommand } from './voiceCommands';

type AudioEvents = {
  pcm: (chunk: { data: string; level: number; interrupted: boolean }) => void;
  audioError: () => void;
};
type LensAudio = {
  addListener<K extends keyof AudioEvents>(event: K, listener: AudioEvents[K]): { remove(): void };
  start(): Promise<boolean>;
  stop(): void;
  mute(muted: boolean): void;
  clear(): void;
  play(data: string): void;
  playing(): boolean;
};
const audio = requireOptionalNativeModule<LensAudio>('LensAudio');
// React Native accepts a headers option in addition to the browser constructor arguments.
const NativeWebSocket = WebSocket as new (
  url: string, protocols?: string[], options?: { headers: Record<string, string> },
) => WebSocket;
const allowed = new Set<VoiceCommand>([
  'open', 'rescan', 'close', 'capture', 'captureText', 'guide', 'read', 'repeat',
  'stop', 'disable', 'localFraming', 'geminiFraming', 'describe', 'summary', 'help', 'look',
]);
type Mode = 'home' | 'camera' | 'busy' | 'result';
type Options = {
  enabled: boolean;
  mode: Mode;
  video: boolean;
  paused: boolean;
  beforeStart: () => Promise<boolean>;
  onCommand: (command: VoiceCommand) => void;
  onQuestion: (value: string) => void;
};

export function useLiveAssistant(options: Options) {
  const [status, setStatus] = useState<'off' | 'connecting' | 'online' | 'fallback'>('off');
  const socket = useRef<WebSocket | null>(null);
  const online = useRef(false);
  const lastSpeechAt = useRef(0);
  const lastFrameAt = useRef(0);
  const epoch = useRef(0);
  const audioArrivedAt = useRef(0);
  const playbackSuppressed = useRef(false);
  const echoEnabled = useRef(false);
  const previous = useRef('');
  const nextSpeechId = useRef(0);
  const narration = useRef<{ id: number; current?: () => boolean; timer: ReturnType<typeof setTimeout> } | null>(null);

  const send = (packet: object) => {
    const ws = socket.current;
    if (!online.current || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      if (ws.bufferedAmount > 350000) return false;
      ws.send(JSON.stringify(packet));
      return true;
    } catch {
      return false;
    }
  };
  const finishNarration = () => {
    if (narration.current) clearTimeout(narration.current.timer);
    narration.current = null;
  };
  const stopOutput = () => {
    if (narration.current) send({ type: 'cancelSpeech', id: narration.current.id });
    finishNarration();
    playbackSuppressed.current = true;
    audioArrivedAt.current = 0;
    audio?.clear();
  };
  const halt = () => {
    stopOutput();
    online.current = false;
    audio?.stop();
    const ws = socket.current;
    socket.current = null;
    ws?.close();
  };
  const syncMode = useEffectEvent(() => {
    if (online.current) send({ type: 'mode', mode: options.mode, video: options.video });
  });
  const pauseFrame = useEffectEvent(() => {
    if (online.current) audio?.mute(options.paused);
  });
  useEffect(() => { syncMode(); }, [options.mode, options.video]);
  useEffect(() => { pauseFrame(); }, [options.paused]);

  const startAudio = useEffectEvent(async () => {
    if (!audio || !(await options.beforeStart())) throw new Error('Microphone is busy');
    echoEnabled.current = await audio.start();
    console.info('Everyday Lens Live audio started. Echo cancellation:', echoEnabled.current);
  });
  const received = useEffectEvent((data: Record<string, unknown>) => {
    if (data.type === 'command' && allowed.has(data.command as VoiceCommand)) {
      stopOutput();
      options.onCommand(data.command as VoiceCommand);
    } else if (data.type === 'question' && options.mode === 'result' && typeof data.text === 'string') {
      stopOutput();
      options.onQuestion(data.text);
    } else if (data.type === 'interrupted') {
      audio?.clear();
      finishNarration();
      playbackSuppressed.current = false;
      audioArrivedAt.current = 0;
    } else if (data.type === 'audio' && typeof data.data === 'string'
      && (data.epoch as number) >= epoch.current) {
      epoch.current = data.epoch as number;
      if (data.id != null && data.id !== narration.current?.id) return;
      if (data.id != null && narration.current?.current?.() === false) {
        stopOutput();
        return;
      }
      if (options.paused) playbackSuppressed.current = true;
      if (playbackSuppressed.current) return;
      audioArrivedAt.current = Date.now();
      audio?.play(data.data);
    } else if (data.type === 'transcript' && typeof data.text === 'string' && !playbackSuppressed.current) {
      previous.current = data.text;
    } else if (data.type === 'turn') {
      if (data.id != null && data.id === narration.current?.id) finishNarration();
      playbackSuppressed.current = false;
    }
  });
  const pushAudio = useEffectEvent(({ data, level, interrupted }: Parameters<AudioEvents['pcm']>[0]) => {
    if (!online.current || options.paused || AppState.currentState !== 'active') return;
    if (interrupted) {
      stopOutput();
      console.info('Everyday Lens Live playback interrupted by speech.');
    }
    if (!echoEnabled.current && audio?.playing()) return;
    if (level > 400) lastSpeechAt.current = Date.now();
    send({ type: 'audio', data });
  });

  useEffect(() => {
    if (!options.enabled || Platform.OS !== 'android' || !audio) {
      setStatus('off');
      return;
    }
    let disposed = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let handshake: ReturnType<typeof setTimeout> | undefined;
    const accessCheck = new AbortController();
    const microphone = audio.addListener('pcm', chunk => pushAudio(chunk));
    const deviceError = audio.addListener('audioError', () => socket.current?.close());

    const retryConnection = () => {
      if (disposed) return;
      setStatus('fallback');
      failures = Math.min(failures + 1, 4);
      retry = setTimeout(() => void connect().catch(retryConnection), 2500 * 2 ** failures);
    };

    const connect = async () => {
      if (disposed || AppState.currentState !== 'active') return;
      setStatus('connecting');
      const target = getServer();
      const check = new AbortController();
      const cancel = () => check.abort();
      const checkTimeout = setTimeout(cancel, 10000);
      accessCheck.signal.addEventListener('abort', cancel);
      try {
        if (!(await checkLiveAccess(target, check.signal))) return;
      } finally {
        clearTimeout(checkTimeout);
        accessCheck.signal.removeEventListener('abort', cancel);
      }
      if (disposed || getServer() !== target || AppState.currentState !== 'active') return;
      let permission = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (!permission) permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
        === PermissionsAndroid.RESULTS.GRANTED;
      if (disposed) return;
      if (!permission) {
        setStatus('fallback');
        return;
      }
      const ws = new NativeWebSocket(target.url.replace(/^http/i, 'ws') + '/live', [], {
        headers: authorization(target),
      });
      socket.current = ws;
      const started = Date.now();
      const lost = () => {
        if (socket.current !== ws || disposed) return;
        socket.current = null;
        online.current = false;
        clearTimeout(handshake);
        audio.stop();
        audioArrivedAt.current = 0;
        finishNarration();
        retryConnection();
      };
      const disconnect = () => { lost(); ws.close(); };
      handshake = setTimeout(disconnect, 10000);
      ws.onclose = lost;
      ws.onerror = disconnect;
      ws.onmessage = async event => {
        if (socket.current !== ws || disposed) return;
        let data: Record<string, unknown>;
        try { data = JSON.parse(String(event.data)); } catch { return; }
        if (data.type === 'unavailable') {
          disconnect();
          return;
        }
        if (data.type === 'ready') {
          clearTimeout(handshake);
          epoch.current = Number(data.epoch) || 0;
          if (!online.current) {
            try { await startAudio(); }
            catch { disconnect(); return; }
            if (disposed || socket.current !== ws) {
              audio.stop();
              return;
            }
          }
          online.current = true;
          playbackSuppressed.current = false;
          failures = 0;
          setStatus('online');
          syncMode();
          pauseFrame();
          console.info('Everyday Lens Live ready ms:', Date.now() - started);
        } else if (online.current) received(data);
      };
    };
    void connect().catch(retryConnection);
    return () => {
      disposed = true;
      accessCheck.abort();
      clearTimeout(retry);
      clearTimeout(handshake);
      microphone.remove();
      deviceError.remove();
      halt();
    };
  }, [options.enabled]);

  return {
    status,
    available: !!audio,
    halt,
    stopOutput,
    cameraOff: () => {
      stopOutput();
      send({ type: 'mode', mode: 'home', video: false });
    },
    quiet: () => Date.now() - lastSpeechAt.current > 500
      && Date.now() - audioArrivedAt.current > 450 && !narration.current && !audio?.playing(),
    look: () => {
      playbackSuppressed.current = false;
      return send({ type: 'look' });
    },
    previous,
    speak: (text: string, delivery: 'verbatim' | 'grounded' = 'verbatim', current?: () => boolean) => {
      if (!online.current || current?.() === false) return false;
      if (delivery === 'grounded' && !send({ type: 'mode', mode: 'result', video: false })) return false;
      stopOutput();
      playbackSuppressed.current = false;
      const id = ++nextSpeechId.current;
      if (!send({ type: 'speak', delivery, id, text: text.slice(0, 3000) })) return false;
      narration.current = { id, current, timer: setTimeout(() => {
        if (narration.current?.id === id) stopOutput();
      }, 10000) };
      return true;
    },
    frame: async (uri: string, sampledAt: number, quiet: boolean) => {
      if (!online.current || !options.video || options.mode !== 'camera' || Date.now() - sampledAt > 850
        || Date.now() - lastFrameAt.current < 1050) return;
      lastFrameAt.current = Date.now();
      try {
        const file = new File(uri);
        if (file.size > 250000) return;
        const data = await file.base64();
        if (Date.now() - sampledAt < 1000 && AppState.currentState === 'active') {
          send({ type: 'frame', data, quiet: quiet && Date.now() - lastSpeechAt.current > 900
            && Date.now() - audioArrivedAt.current > 450 && !narration.current && !audio?.playing() });
        }
      } catch {
        // Preview frames are disposable and the next sample will retry.
      }
    },
  };
}
