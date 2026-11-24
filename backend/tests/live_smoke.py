"""Real Live API smoke test against localhost. Uses generated speech and a demo receipt."""
import asyncio
import base64
import json
import os
import ssl
from time import perf_counter

import numpy as np
import websockets
from dotenv import dotenv_values
from google import genai
from google.genai import types

from tests.test_workflow import receipt


async def event(socket, expected, timeout=25, require_audio=False):
    audio_bytes = 0
    async with asyncio.timeout(timeout):
        while True:
            message = json.loads(await socket.recv())
            if message['type'] == 'audio':
                audio_bytes += len(base64.b64decode(message['data']))
            if message['type'] == expected:
                if require_audio:
                    assert audio_bytes >= 4800, 'Native narration did not carry a playable audio stream.'
                return message
            if message['type'] == 'unavailable':
                raise RuntimeError('The backend could not establish a Live session.')


async def run():
    settings = dotenv_values('.env', interpolate=False)
    key = os.getenv('GEMINI_API_KEY') or settings.get('GEMINI_API_KEY')
    model = os.getenv('GEMINI_LIVE_MODEL') or settings.get('GEMINI_LIVE_MODEL') or 'gemini-3.8-live'
    async with asyncio.timeout(30):
        async with genai.Client(api_key=key, http_options={'api_version': 'v1beta'}).aio as client:
            async with client.live.connect(model=model, config=types.LiveConnectConfig(
                response_modalities=['AUDIO'],
            )) as session:
                await session.send_realtime_input(text='Say exactly two words and nothing else: Open camera.')
                seed = b''.join([message.data async for message in session.receive() if message.data])
    samples = np.frombuffer(seed, dtype='<i2')
    assert len(samples) > 2400 and max(abs(samples.astype(float))) > 100, 'No voice in the generated fixture.'
    pcm = np.interp(np.arange(0, len(samples) - 1, 1.5), np.arange(len(samples)), samples).astype('<i2').tobytes()
    initial = perf_counter()
    url = os.getenv('LENS_TEST_LIVE_URL', 'ws://127.0.0.1:8002/live')
    access_key = os.getenv('LENS_ACCESS_KEY')
    headers = {'Authorization': 'Bearer ' + access_key} if access_key else None
    certificate = os.getenv('LENS_TEST_CERT')
    tls = {'ssl': ssl.create_default_context(cafile=certificate)} if certificate else {}
    async with websockets.connect(url, additional_headers=headers, max_size=512_000, **tls) as phone:
        await event(phone, 'ready')
        print(f'WebSocket ready in {round((perf_counter() - initial) * 1000)} ms', flush=True)
        await phone.send(json.dumps({'type': 'mode', 'mode': 'home', 'video': False}))
        for offset in range(0, len(pcm) + 32000, 2560):
            chunk = (pcm[offset:offset + 2560] if offset < len(pcm) else b'\0' * 2560)
            await phone.send(json.dumps({'type': 'audio', 'data': base64.b64encode(chunk).decode()}))
            await asyncio.sleep(0.08)
        received = await event(phone, 'command')
        assert received['command'] == 'open', received['command']
        print('Streamed PCM selected open camera', flush=True)
        await phone.send(json.dumps({'type': 'mode', 'mode': 'camera', 'video': True}))
        await asyncio.sleep(0.25)
        demo = base64.b64encode(receipt(frame_size=(480, 640), left=120, top=100, width=245, height=410)).decode()
        for _ in range(5):
            await phone.send(json.dumps({'type': 'frame', 'data': demo, 'quiet': True}))
            await asyncio.sleep(1.05)
        reply = await event(phone, 'transcript', require_audio=True)
        assert reply['text'].strip()
        print('Portrait preview frames triggered native scene narration', flush=True)
        await phone.send(json.dumps({'type': 'speak', 'delivery': 'verbatim', 'id': 7, 'text': 'Move slightly left.'}))
        cue = await event(phone, 'transcript', require_audio=True)
        assert 'left' in cue['text'].lower()
        print('Gemini Live narrated the exact framing direction', flush=True)
        await phone.send(json.dumps({'type': 'mode', 'mode': 'result', 'video': False}))
        await phone.send(json.dumps({'type': 'speak', 'text': '{"answer":"The printed total is 45."}'}))
        alternative = await event(phone, 'transcript', require_audio=True)
        assert any(word in alternative['text'].lower() for word in ('45', 'forty'))
        print('Trusted answer was narrated by Gemini Live', flush=True)


if __name__ == '__main__':
    asyncio.run(run())
