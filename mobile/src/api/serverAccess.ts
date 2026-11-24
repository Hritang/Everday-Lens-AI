import { requireOptionalNativeModule } from 'expo';
import { fetch } from 'expo/fetch';

type SavedPairing = { url: string; secret: string };
type PairingStorage = {
  loadServerPairing(): Promise<SavedPairing | null>;
  saveServerPairing(url: string, secret: string): Promise<void>;
  clearServerPairing(): Promise<void>;
};

type Server = { url: string; remote: boolean; secret: string | null };
const secretPattern = /^[A-Za-z0-9_-]{43,128}$/;
const usbAddress = 'http://127.0.0.1:8000';
const storage = requireOptionalNativeModule<PairingStorage>('LensAudio');
const configured = (process.env.EXPO_PUBLIC_API_BASE_URL || usbAddress).trim().replace(/\/+$/, '');
const listeners = new Set<() => void>();

function hostedOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch {
    // An incomplete or invalid address can be corrected in the pairing screen.
  }
  return null;
}

const usesUsb = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(configured);
let server: Server = { url: usesUsb ? configured : hostedOrigin(configured) ?? '', remote: !usesUsb, secret: null };

function update(next: Server) {
  server = next;
  listeners.forEach(listener => listener());
}

export const getServer = () => server;
export function subscribeServer(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function authorization(target: Server) {
  const headers: Record<string, string> = {};
  if (target.remote && target.secret) headers.Authorization = 'Bearer ' + target.secret;
  return headers;
}

export function rejectPairing(target: Server) {
  if (server === target && server.remote && server.secret) update({ ...server, secret: null });
}

export async function restoreServer() {
  const saved = await storage?.loadServerPairing();
  const url = saved && hostedOrigin(saved.url);
  if (saved && url && secretPattern.test(saved.secret)) update({ url, secret: saved.secret, remote: true });
}

async function checkPairing(target: Server, signal: AbortSignal) {
  return fetch(target.url + '/pair', {
    method: 'POST', headers: authorization(target), redirect: 'error', signal,
  });
}

export async function checkLiveAccess(target: Server, signal: AbortSignal) {
  if (!target.remote) return true;
  if (!target.secret) return false;
  const response = await checkPairing(target, signal);
  if (response.status === 401 || response.status === 403) {
    rejectPairing(target);
    return false;
  }
  if (response.status !== 204) throw new Error('Server pairing is unavailable.');
  return true;
}

export async function pairServer(address: string, key: string) {
  const url = hostedOrigin(address);
  const secret = key.trim();
  if (!url) throw new Error('Enter a server address that starts with https://.');
  if (!secretPattern.test(secret)) throw new Error('Paste the full server access key.');
  if (!storage) throw new Error('Use the installed Android app to save a pairing.');

  const target = { url, secret, remote: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    let response: Response;
    try {
      response = await checkPairing(target, controller.signal);
    } catch {
      throw new Error('Could not reach that server. Check the address and try again.');
    }
    if (response.status === 401 || response.status === 403) throw new Error('The server did not accept that access key.');
    if (response.status !== 204) throw new Error('Pairing is unavailable. Check the server configuration and try again.');
    try {
      await storage.saveServerPairing(url, secret);
    } catch {
      throw new Error('Could not save this pairing securely on the phone.');
    }
    update(target);
  } finally {
    clearTimeout(timer);
  }
}

export async function useUsbServer() {
  await storage?.clearServerPairing();
  update({ url: usbAddress, remote: false, secret: null });
}
