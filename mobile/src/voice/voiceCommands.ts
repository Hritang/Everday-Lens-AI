import { requireOptionalNativeModule } from 'expo';
import { File, Paths } from 'expo-file-system';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ExpoSpeechRecognitionErrorCode } from 'expo-speech-recognition';
import { AppState } from 'react-native';

type SpeechRecognizer = typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule;
const recognizer = requireOptionalNativeModule<SpeechRecognizer>('ExpoSpeechRecognition');
const privacy = requireOptionalNativeModule<{
  readListeningPreference(): boolean | null;
  saveListeningPreference(enabled: boolean): boolean;
}>('LensAudio');

export function listeningPreference(enabled?: boolean) {
  try {
    if (privacy && enabled !== undefined) {
      if (!privacy.saveListeningPreference(enabled)) console.warn('Could not save the listening preference.');
      return enabled;
    }
    if (enabled === undefined) {
      const saved = privacy?.readListeningPreference();
      if (saved != null) return saved;
    }
    const preference = new File(Paths.document, 'foreground-listening.txt');
    if (enabled === undefined) return !preference.exists || preference.textSync() !== 'off';
    if (!preference.exists) preference.create();
    preference.writeSync(enabled ? 'on' : 'off');
    return enabled;
  } catch {
    return enabled ?? false;
  }
}

const phrases = {
  'open camera': 'open', 'start scanning': 'open', 'scan document': 'open',
  'guide me': 'guide', 'where is the page': 'guide', 'repeat guidance': 'guide', 'check alignment': 'guide',
  'help me align this document': 'guide',
  'what can you see': 'look', 'what is in front of me': 'look',
  'use local framing': 'localFraming', 'use lens ai framing': 'geminiFraming', 'use lens a i framing': 'geminiFraming',
  'use gemini framing': 'geminiFraming',
  capture: 'capture', 'capture anyway': 'capture', 'scan now': 'capture',
  'capture photo': 'capture', 'take photo': 'capture', 'take picture': 'capture',
  'capture text only': 'captureText',
  repeat: 'repeat', 'repeat that': 'repeat', 'repeat message': 'repeat', 'say that again': 'repeat',
  read: 'read', 'read this': 'read', 'read again': 'read', 'read document': 'read', 'read aloud': 'read',
  stop: 'stop', 'stop speaking': 'stop', 'stop talking': 'stop', 'be quiet': 'stop',
  'stop listening': 'disable', 'stop listen': 'disable',
  'pause listening': 'disable', 'turn off listening': 'disable',
  'go back': 'close', home: 'close', 'close camera': 'close', exit: 'close',
  'try again': 'rescan', 'scan again': 'rescan', rescan: 'rescan', retry: 'retry',
  slower: 'slower', faster: 'faster',
  summarize: 'summary', 'summarize this': 'summary', 'shorter explanation': 'summary',
  'describe image': 'describe', 'describe this': 'describe', 'what is this': 'describe',
  'ask question': 'ask', 'ask a question': 'ask',
  cancel: 'cancel', help: 'help', 'what can i say': 'help',
} as const;

export type VoiceCommand = (typeof phrases)[keyof typeof phrases];

function normalized(transcript: string) {
  return transcript.toLowerCase().replace(/[^a-z\s]/g, ' ').trim()
    .replace(/\s+/g, ' ').replace(/^please | please$/g, '');
}

export function matchVoiceCommand(transcript: string): VoiceCommand | undefined {
  const phrase = normalized(transcript).replace(/\b(a|the) (?=camera|photo|picture|image|document)/g, '');
  if (Object.hasOwn(phrases, phrase)) return phrases[phrase as keyof typeof phrases];
}

export function isDocumentQuestion(transcript: string) {
  const phrase = normalized(transcript);
  return phrase.includes(' ') && (transcript.trim().endsWith('?')
    || /^(what|where|when|who|why|which|how|is|are|was|were|can|could|does|do|did|has|have|will|tell me)\s/.test(phrase));
}

export function selectTranscript(results: readonly { transcript: string }[]) {
  const privacyStop = results.find(result => matchVoiceCommand(result.transcript) === 'disable');
  return (privacyStop ?? results[0])?.transcript.trim();
}

type Phase = 'idle' | 'preparing' | 'starting' | 'listening' | 'processing' | 'stopping';
type Mode = 'command' | 'question';
type Session = {
  mode: Mode;
  automatic: boolean;
  started: boolean;
  listeningAt?: number;
  heardSpeech?: boolean;
  cancelled: boolean;
  transcript?: string;
  error?: ExpoSpeechRecognitionErrorCode;
  timer?: ReturnType<typeof setTimeout>;
  ended: Promise<boolean>;
  resolve: (quiet: boolean) => void;
};

type Options = {
  automatic: boolean;
  ready: boolean;
  acceptsQuestions: boolean;
  onCommand: (command: VoiceCommand) => void;
  onQuestion: (question: string) => void;
  onFeedback: (message: string) => void;
  stopSpeaking: () => Promise<void>;
  questionCue: () => Promise<void>;
};

export function useVoiceCommands(options: Options) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [blocked, setBlocked] = useState(false);
  const session = useRef<Session | null>(null);
  const manualStart = useRef(false);
  const failures = useRef(0);
  const retryAt = useRef(0);

  const release = (current: Session, quiet: boolean) => {
    clearTimeout(current.timer);
    if (session.current === current && quiet) {
      session.current = null;
      setPhase('idle');
    }
    current.resolve(quiet);
  };

  const pauseForOutput = async () => {
    const current = session.current;
    if (!current || !recognizer) return true;
    if (!current.started) {
      current.cancelled = true;
      release(current, true);
      return true;
    }
    if (!current.cancelled) {
      current.cancelled = true;
      clearTimeout(current.timer);
      setPhase('stopping');
      current.timer = setTimeout(async () => {
        if (session.current !== current) return;
        const quiet = await recognizer.getStateAsync().then(state => state === 'inactive').catch(() => false);
        if (session.current !== current) return;
        if (!quiet) setBlocked(true);
        release(current, quiet);
      }, 2400);
      recognizer.abort();
    }
    return current.ended;
  };

  const finish = useEffectEvent(() => {
    const completed = session.current;
    if (!completed?.started) return;
    release(completed, true);
    if (completed.cancelled) return;
    const error = completed.error;
    if (error && error !== 'no-speech' && error !== 'speech-timeout' && error !== 'aborted') {
      failures.current++;
      retryAt.current = Date.now() + Math.min(12000, 1500 * 2 ** (failures.current - 1));
      if (error === 'not-allowed' || error === 'service-not-allowed' || error === 'language-not-supported') setBlocked(true);
      if (failures.current === 1) {
        options.onFeedback(error === 'network'
          ? 'The speech service could not connect. Retrying. Accessible controls are available.'
          : 'Speech recognition is unavailable. Use the accessible controls or resume listening to try again.');
      }
      return;
    }

    failures.current = 0;
    retryAt.current = Date.now() + (completed.transcript ? 450 : 1300);
    const transcript = completed.transcript;
    if (transcript && !error) {
      const command = matchVoiceCommand(transcript);
      if (command && (completed.mode === 'command' || ['disable', 'stop', 'close', 'cancel', 'help'].includes(command))) {
        options.onCommand(command);
      } else if (completed.mode === 'question' || (options.acceptsQuestions && isDocumentQuestion(transcript))) {
        options.onQuestion(transcript);
      } else {
        options.onFeedback('I could not understand that command. Say help for available commands.');
      }
    } else if (!completed.automatic && error !== 'aborted') {
      options.onFeedback(completed.mode === 'question'
        ? 'I did not catch your question. You can ask again.'
        : 'I did not catch a command. You can try again.');
    }
  });

  const pauseInBackground = useEffectEvent(() => {
    if (session.current?.started) void pauseForOutput();
  });

  useEffect(() => {
    if (!recognizer) return;
    const subscriptions = [
      recognizer.addListener('start', () => {
        if (session.current?.started && !session.current.cancelled) {
          session.current.listeningAt = Date.now();
          setPhase('listening');
        }
      }),
      recognizer.addListener('speechstart', () => {
        if (session.current?.started && !session.current.cancelled) session.current.heardSpeech = true;
      }),
      recognizer.addListener('speechend', () => {
        if (session.current?.started && !session.current.cancelled) {
          session.current.heardSpeech = true;
          setPhase('processing');
        }
      }),
      recognizer.addListener('result', ({ isFinal, results }) => {
        if (session.current?.started && !session.current.cancelled && isFinal && results[0]) {
          session.current.transcript = selectTranscript(results);
        }
      }),
      recognizer.addListener('error', ({ error }) => {
        if (session.current?.started) session.current.error = error;
      }),
      recognizer.addListener('end', () => finish()),
      AppState.addEventListener('change', next => {
        if (next !== 'active') pauseInBackground();
      }),
    ];
    return () => {
      subscriptions.forEach(subscription => subscription.remove());
      const current = session.current;
      session.current = null;
      if (current) {
        clearTimeout(current.timer);
        if (current.started) recognizer.abort();
        current.resolve(false);
      }
    };
  }, []);

  const start = async (mode: Mode, automatic: boolean) => {
    if (!recognizer || session.current || AppState.currentState === 'background') return;
    let resolve!: Session['resolve'];
    const ended = new Promise<boolean>(done => { resolve = done; });
    const current: Session = { mode, automatic, started: false, cancelled: false, ended, resolve };
    session.current = current;
    setPhase('preparing');
    try {
      if (!recognizer.isRecognitionAvailable()) throw new Error('Android speech recognition is unavailable. You can use the accessible controls.');
      let permission = await recognizer.getPermissionsAsync();
      if (session.current !== current) return;
      if (!permission.granted && permission.canAskAgain) permission = await recognizer.requestPermissionsAsync();
      if (session.current !== current) return;
      if (!permission.granted) throw new Error('Microphone access is off. Use the accessible controls or allow access in Android settings.');
      if (mode === 'question') await options.questionCue();
      if (session.current !== current) return;
      await options.stopSpeaking();
      if (session.current !== current) return;
      if (AppState.currentState !== 'active') {
        release(current, true);
        return;
      }
      current.started = true;
      setPhase('starting');
      current.timer = setTimeout(() => {
        retryAt.current = Date.now() + 1500;
        void pauseForOutput();
      }, 18000);
      recognizer.start({
        lang: 'en-IN', interimResults: false, continuous: false, maxAlternatives: 5,
        ...(mode === 'command' && !options.acceptsQuestions ? { contextualStrings: Object.keys(phrases) } : {}),
      });
    } catch (error) {
      if (session.current !== current) return;
      release(current, true);
      setBlocked(true);
      options.onFeedback(error instanceof Error ? error.message : 'Could not start voice recognition. Use the accessible controls.');
    }
  };

  const startAutomatic = useEffectEvent(() => {
    if (options.automatic && options.ready && !manualStart.current && AppState.currentState === 'active') {
      void start('command', true);
    }
  });
  useEffect(() => {
    if (!recognizer || blocked || !options.automatic || !options.ready || phase !== 'idle') return;
    const timer = setTimeout(() => startAutomatic(), Math.max(450, retryAt.current - Date.now()));
    return () => clearTimeout(timer);
  }, [blocked, options.automatic, options.ready, phase]);

  return {
    available: !!recognizer,
    blocked,
    phase,
    pauseForOutput,
    canYieldForGuidance: () => {
      const current = session.current;
      return !current || (current.automatic && current.listeningAt !== undefined
        && !current.cancelled && !current.heardSpeech && Date.now() - current.listeningAt >= 1500);
    },
    resume: () => { failures.current = 0; retryAt.current = 0; setBlocked(false); },
    askByVoice: async () => {
      if (manualStart.current) return;
      manualStart.current = true;
      try {
        if (await pauseForOutput()) await start('question', false);
      } finally {
        manualStart.current = false;
      }
    },
  };
}
