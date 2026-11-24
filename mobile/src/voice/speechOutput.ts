import * as Speech from 'expo-speech';
import { useEffect, useRef, useState } from 'react';
import { chooseEnglishVoice, speechChunks } from './voiceSelection';

type Outcome = 'done' | 'stopped' | 'failed' | 'failed-before-start';

async function availableVoice() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Speech.getAvailableVoicesAsync().then(chooseEnglishVoice).catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(resolve, 2200); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function useSpeechOutput() {
  const revision = useRef(0);
  const rate = useRef(0.92);
  const lastMessage = useRef('');
  const speaking = useRef(false);
  const [active, setActive] = useState(false);
  const playback = useRef(Promise.resolve());
  const voice = useRef<Promise<Speech.Voice | undefined> | null>(null);
  const interrupt = useRef<(() => void) | null>(null);

  const stop = async () => {
    const request = ++revision.current;
    interrupt.current?.();
    const stopped = Speech.stop().catch(() => {});
    playback.current = Promise.all([playback.current, stopped]).then(() => {});
    await stopped;
    if (revision.current === request) {
      speaking.current = false;
      setActive(false);
    }
  };

  const speakPart = (part: string, selected?: Speech.Voice) => new Promise<Outcome>(resolve => {
    let started = false;
    const finish = (outcome: Outcome) => {
      clearTimeout(timer);
      if (interrupt.current === cancel) interrupt.current = null;
      resolve(outcome);
    };
    const cancel = () => finish('stopped');
    const error = () => finish(started ? 'failed' : 'failed-before-start');
    const timer = setTimeout(error, Math.max(7500, part.length * 200));
    interrupt.current = cancel;
    try {
      Speech.speak(part, {
        language: 'en', voice: selected?.identifier, rate: rate.current, pitch: 1.0,
        onStart: () => { started = true; },
        onDone: () => finish('done'),
        onStopped: cancel,
        onError: error,
      });
    } catch {
      error();
    }
  });

  const speak = async (message: string, remember = true, beforeSpeech?: () => Promise<boolean>) => {
    const request = ++revision.current;
    speaking.current = true;
    setActive(true);
    const play = playback.current.then(async () => {
      if (revision.current !== request || (beforeSpeech && !(await beforeSpeech()))) return;
      if (revision.current !== request) return;
      if (remember) lastMessage.current = message;
      voice.current ??= availableVoice().then(selected => {
        console.info('Everyday Lens TTS voice:', selected?.identifier ?? 'Android default English');
        return selected;
      });
      let selected = await voice.current;
      for (const part of speechChunks(message, Math.min(480, Speech.maxSpeechInputLength))) {
        if (revision.current !== request) return;
        let outcome = await speakPart(part, selected);
        if (outcome === 'failed-before-start' && selected && revision.current === request) {
          await Speech.stop();
          voice.current = Promise.resolve(undefined);
          selected = undefined;
          if (revision.current !== request) return;
          console.info('Everyday Lens TTS voice fell back to Android default English.');
          outcome = await speakPart(part);
        }
        if (outcome !== 'done') {
          if (revision.current === request) await Speech.stop();
          return;
        }
      }
      return true;
    });
    playback.current = play.then(() => {}, () => {});
    const completed = await play.catch(() => false);
    if (revision.current === request) {
      speaking.current = false;
      setActive(false);
    }
    return completed === true && revision.current === request;
  };

  const changeRate = (delta: number) => {
    rate.current = Math.max(0.55, Math.min(1.25, rate.current + delta));
  };

  useEffect(() => () => {
    revision.current++;
    interrupt.current?.();
    void Speech.stop().catch(() => {});
  }, []);

  return { speak, stop, lastMessage, speaking, active, changeRate };
}
