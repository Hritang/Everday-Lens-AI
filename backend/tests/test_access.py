import os
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app


class ServerAccessTests(unittest.TestCase):
    url = 'https://lens.example'
    headers = {'Authorization': 'Bearer ' + 'a' * 43}

    def setUp(self):
        self.internet = TestClient(app, base_url=self.url, client=('192.0.2.4', 50000))
        self.usb = TestClient(app, client=('127.0.0.1', 50000))

    def test_usb_default_keeps_local_access_only(self):
        with patch.dict(os.environ, {'LENS_REMOTE_MODE': '0', 'LENS_ACCESS_KEY': ''}):
            self.assertEqual(self.internet.get('/health').status_code, 200)
            self.assertEqual(self.internet.post('/ocr').status_code, 403)
            self.assertEqual(self.usb.post('/ocr').status_code, 422)  # Upload validation is reached.
            self.assertEqual(self.usb.post('/pair').status_code, 503)
            with self.assertRaises(WebSocketDisconnect):
                with self.internet.websocket_connect('/live'):
                    self.fail('Unpaired remote socket opened.')

    def test_remote_mode_without_key_fails_closed(self):
        with patch.dict(os.environ, {'LENS_REMOTE_MODE': '1', 'LENS_ACCESS_KEY': ''}):
            self.assertEqual(self.usb.get('/health').status_code, 200)
            self.assertEqual(self.usb.post('/ocr').status_code, 503)
            with self.assertRaises(WebSocketDisconnect):
                with self.usb.websocket_connect('/live'):
                    self.fail('Misconfigured remote mode opened a socket.')

    def test_remote_token_gates_all_processing_and_pairing(self):
        with patch.dict(os.environ, {'LENS_REMOTE_MODE': '1', 'LENS_ACCESS_KEY': 'a' * 43}):
            for client in (self.usb, self.internet):
                for path in ('/pair', '/alignment', '/alignment/vision', '/ocr', '/analyze', '/ask'):
                    with self.subTest(path=path):
                        response = client.post(path)
                        self.assertEqual(response.status_code, 401)
                        self.assertEqual(response.headers.get('WWW-Authenticate'), 'Bearer')
                self.assertEqual(client.post('/pair', headers=self.headers).status_code, 204)
                self.assertEqual(client.post('/ocr', headers=self.headers).status_code, 422)
                self.assertEqual(client.post('/pair?token=' + 'a' * 43).status_code, 401)
                self.assertEqual(client.post('/pair', headers={'Authorization': 'Bearer ' + 'b' * 43}).status_code, 401)

    def test_remote_socket_checks_authentication_and_origin_before_live_setup(self):
        with (patch.dict(os.environ, {'LENS_REMOTE_MODE': '1', 'LENS_ACCESS_KEY': 'a' * 43, 'GEMINI_API_KEY': ''}),
              patch('app.live._env_file', Path('__missing__.env'))):
            for headers in ({}, {**self.headers, 'Origin': 'https://other.example'}):
                with self.assertRaises(WebSocketDisconnect):
                    with self.internet.websocket_connect('wss://lens.example/live', headers=headers):
                        self.fail('Unauthorized socket opened.')
            with self.internet.websocket_connect('wss://lens.example/live', headers={**self.headers, 'Origin': self.url}) as ws:
                self.assertEqual(ws.receive_json(), {'type': 'unavailable'})  # Authentication passed.
