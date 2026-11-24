import { fetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { authorization, getServer, rejectPairing } from './serverAccess';

export type Alignment = {
  detected: boolean;
  ready: boolean;
  direction: string;
  message: string;
  quality: { clipped: boolean; blurred: boolean; too_small: boolean; tilted: boolean; too_close: boolean };
  metrics: {
    center_x: number; center_y: number; area_ratio: number; tilt_degrees: number; sharpness: number;
    corners: [number, number][]; boundary_score: number;
  } | null;
  frame_width: number;
  frame_height: number;
};

export type VisionAlignment = {
  alignment: Alignment;
  source: 'opencv' | 'gemini';
  vision_status: 'ok' | 'disabled' | 'busy' | 'rate_limited' | 'quota' | 'timeout' | 'unavailable';
  vision_ms: number | null;
  retry_after_ms: number | null;
};

export type OcrResult = { text: string; warnings: string[] };
export type Description = { description: string; warnings: string[]; uncertain: boolean; ai_generated: true };
export type Answer = { answer: string; supporting_text: string; uncertain: boolean; ai_generated: true };

export class ServiceError extends Error {
  constructor(message: string, readonly kind: 'server' | 'connection' | 'timeout' | 'image' = 'server') {
    super(message);
  }
}

async function postPhoto<T>(
  endpoint: string,
  uri: string,
  fields: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const target = getServer();
  if (target.remote && !target.secret) throw new ServiceError('Pair this phone with the Lens AI server.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timeout = setTimeout(cancel, timeoutMs);
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel);
  try {
    const image = new File(uri);
    if (!image.exists) throw new ServiceError('The temporary photo is missing. Capture the document again.', 'image');
    const body = new FormData();
    body.append('image', image, 'document.jpg');
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    const response = await fetch(target.url + endpoint, {
      method: 'POST', body, headers: authorization(target), redirect: 'error', signal: controller.signal,
    });
    if (target.remote && (response.status === 401 || response.status === 403)) {
      rejectPairing(target);
      throw new ServiceError('Pair this phone with the Lens AI server.');
    }
    if (!response.ok && response.status >= 500 && !response.headers.get('content-type')?.includes('json')) {
      throw new ServiceError('The document service is temporarily unavailable.');
    }
    const data = await response.json();
    if (!response.ok) {
      throw new ServiceError(typeof data.detail === 'string' ? data.detail : 'The server could not process the request.',
        [400, 413, 415, 422].includes(response.status) ? 'image' : 'server');
    }
    return data as T;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (controller.signal.aborted) throw new ServiceError('The request timed out. Try again.', 'timeout');
    const advice = !target.remote
      ? 'Check the USB cable and that the backend is running on the PC.'
      : 'Check the phone’s internet connection and try again.';
    throw new ServiceError('Could not reach the document service. ' + advice, 'connection');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export const getAlignment = (uri: string, signal: AbortSignal) =>
  postPhoto<Alignment>('/alignment?portrait=true', uri, {}, getServer().remote ? 2500 : 900, signal);

export const getVisionAlignment = (uri: string, signal: AbortSignal) =>
  postPhoto<VisionAlignment>('/alignment/vision', uri, {}, 7500, signal);

export const getOcr = (uri: string) => postPhoto<OcrResult>('/ocr', uri, {}, 18000);

export const getDescription = (uri: string, text: string, mode: 'describe' | 'summary') =>
  postPhoto<Description>('/analyze', uri, { ocr_text: text.slice(0, 12000), mode }, 31000);

export const getAnswer = (uri: string, text: string, question: string) =>
  postPhoto<Answer>('/ask', uri, { ocr_text: text.slice(0, 12000), question }, 31000);
