import base64
import io
import unittest
from unittest.mock import AsyncMock
from time import monotonic

from PIL import Image

from app.live import LiveBridge, decode_payload, preview_signature, scene_difference, spoken_command


def frame(color, size=(420, 560)):
    file = io.BytesIO()
    Image.new('RGB', size, color).save(file, format='JPEG')
    return file.getvalue()


class LiveProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_framing_narration_waits_for_previous_turn(self):
        bridge = LiveBridge(AsyncMock())
        upstream = AsyncMock()
        bridge.turn_busy = monotonic()
        bridge.narration_pending = (7, 'Move slightly left.', True, monotonic())
        await bridge.narrate(upstream)
        upstream.send_client_content.assert_not_awaited()
        bridge.turn_busy = 0
        await bridge.narrate(upstream)
        self.assertEqual(bridge.narration_id, 7)
        self.assertIn('Move slightly left.', upstream.send_client_content.call_args.kwargs['turns'].parts[0].text)
    def test_intent_requires_a_command_not_a_mention(self):
        self.assertEqual(spoken_command('Please open the camera.'), 'open')
        self.assertEqual(spoken_command('Could you take a photo?'), 'capture')
        self.assertEqual(spoken_command('Capture text only.'), 'captureText')
        self.assertEqual(spoken_command('Stop listening.'), 'disable')
        self.assertEqual(spoken_command('Use Lens AI framing.'), 'geminiFraming')
        self.assertIsNone(spoken_command('Does this sign say capture?'))
        self.assertIsNone(spoken_command('Please do not capture this.'))

    def test_bounded_media_and_portrait(self):
        self.assertEqual(decode_payload('AAEC', 3), b'\0\x01\x02')
        self.assertIsNone(decode_payload('AAEC', 2))
        self.assertIsNone(decode_payload('!Bad', 8))
        self.assertIsNone(preview_signature(frame('white', (560, 420))))
        a = preview_signature(frame('white'))
        b = preview_signature(frame('black'))
        self.assertGreater(scene_difference(a, b), 20)

    async def test_repeated_frames_need_no_new_description(self):
        phone = AsyncMock()
        upstream = AsyncMock()
        bridge = LiveBridge(phone)
        picture = {'data': base64.b64encode(frame('white')).decode(), 'quiet': True}
        await bridge.frame(upstream, picture)
        await bridge.frame(upstream, picture)
        self.assertEqual(upstream.send_realtime_input.await_count, 1)
        bridge.last_frame = 0
        await bridge.frame(upstream, picture)
        self.assertEqual(upstream.send_client_content.await_count, 1)
        bridge.last_frame = bridge.last_scene = bridge.turn_busy = 0
        await bridge.frame(upstream, picture)
        self.assertEqual(upstream.send_client_content.await_count, 1)

    async def test_gemini_cannot_dispatch_a_command_without_user_audio(self):
        phone = AsyncMock()
        bridge = LiveBridge(phone)
        bridge.input_text = 'Capture'
        await bridge.dispatch()
        phone.send_json.assert_not_awaited()
        bridge.user_audio = True
        await bridge.dispatch()
        await bridge.dispatch()
        phone.send_json.assert_awaited_once_with({'type': 'command', 'command': 'capture'})
