import os
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from time import perf_counter

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from pydantic import ValidationError

from app.alignment import analyze_frame
from app.main import app
from app.schemas import VisionAssessment
from app.vision_alignment import VisionAlignment, fuse_alignment


def receipt(left=140, top=80, width=350, height=450, blurred=False, rotation=0, frame_size=(640, 640)):
    page = Image.new('RGB', (width, height), 'white')
    ImageDraw.Draw(page).multiline_text(
        (22, 36), 'DEMO CAFE\nTea  45.00\nTOTAL  45.00', fill='black',
        font=ImageFont.load_default(size=30), spacing=20,
    )
    frame = Image.new('RGB', frame_size, '#232423')
    frame.paste(page, (left, top))
    if rotation:
        frame = frame.rotate(rotation, resample=Image.Resampling.BICUBIC, fillcolor='#232423')
    if blurred:
        frame = frame.filter(ImageFilter.GaussianBlur(3))
    return encode(frame)


def encode(frame, orientation=None):
    data = BytesIO()
    exif = Image.Exif()
    if orientation is not None:
        exif[274] = orientation
    frame.save(data, 'JPEG', quality=92, exif=exif)
    return data.getvalue()


def framing_assessment(**updates):
    return VisionAssessment.model_validate({
        'document_detected': True, 'document_type': 'receipt',
        'horizontal_position': 'left', 'vertical_position': 'center',
        'document_fully_visible': True, 'too_close': False, 'too_far': False,
        'blurry': False, 'tilted': False, 'recommended_action': 'move_left',
        'ready_to_capture': False, **updates,
    })


class DocumentEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, client=('127.0.0.1', 50000))

    def send(self, route, photo, **fields):
        return self.client.post(route, files={'image': ('receipt.jpg', photo, 'image/jpeg')}, data=fields)

    def test_alignment_directions(self):
        for expected, photo in {
            'ready': receipt(),
            'move_right': receipt(left=245),
            'move_left': receipt(left=35),
            'move_up': receipt(top=30, height=350),
            'move_down': receipt(top=240, height=350),
            'move_farther': receipt(left=-35),
            'move_closer': receipt(left=235, top=195, width=170, height=240),
            'rotate_clockwise': receipt(rotation=-18),
            'rotate_counterclockwise': receipt(rotation=18),
            'hold_still': receipt(blurred=True),
            'find_document': encode(Image.new('RGB', (640, 640), '#232423')),
        }.items():
            with self.subTest(direction=expected):
                response = self.send('/alignment', photo)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()['direction'], expected)

    def test_alignment_metrics_explain_ready_and_distance(self):
        ready = self.send('/alignment', receipt()).json()
        self.assertTrue(ready['ready'])
        self.assertGreaterEqual(ready['metrics']['sharpness'], 24)
        self.assertLess(abs(ready['metrics']['center_x'] - 0.5), 0.1)
        self.assertEqual(len(ready['metrics']['corners']), 4)
        self.assertGreater(ready['metrics']['boundary_score'], 0.6)
        close = self.send('/alignment', receipt(left=30, top=30, width=580, height=580)).json()
        self.assertFalse(close['ready'])
        self.assertTrue(close['quality']['too_close'])
        self.assertFalse(close['quality']['clipped'])
        self.assertGreater(close['metrics']['area_ratio'], 0.74)

    def test_portrait_movement_and_exif_normalization(self):
        common = {'width': 220, 'height': 360, 'frame_size': (480, 640)}
        for expected, left, top in (
            ('move_left', 30, 140), ('move_right', 230, 140),
            ('move_up', 130, 40), ('move_down', 130, 240),
        ):
            with self.subTest(direction=expected):
                frame = Image.open(BytesIO(receipt(left=left, top=top, **common)))
                unrotated = self.send('/alignment', encode(frame)).json()
                rotated = self.send('/alignment', encode(frame.transpose(Image.Transpose.ROTATE_90), 6)).json()
                mirrored = self.send('/alignment', encode(frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT), 2)).json()
                for result in (unrotated, rotated, mirrored):
                    self.assertEqual((result['frame_width'], result['frame_height']), (480, 640))
                    self.assertEqual(result['direction'], expected)

    def test_preview_rejects_landscape_and_tiny_clipped_background(self):
        landscape = Image.new('RGB', (560, 420), '#232423')
        self.assertEqual(self.send('/alignment?portrait=true', encode(landscape)).status_code, 422)
        frame = Image.new('RGB', (420, 560), '#232423')
        ImageDraw.Draw(frame).rectangle((0, 70, 58, 175), fill='white')
        result = self.send('/alignment?portrait=true', encode(frame)).json()
        self.assertEqual(result['direction'], 'find_document')

    def test_preview_size_keeps_direction_and_sharpness(self):
        for expected, photo in (
            ('move_left', receipt(left=20, top=115, width=200, height=330, frame_size=(420, 560))),
            ('move_right', receipt(left=205, top=115, width=200, height=330, frame_size=(420, 560))),
            ('move_up', receipt(left=110, top=30, width=200, height=290, frame_size=(420, 560))),
            ('move_down', receipt(left=110, top=240, width=200, height=290, frame_size=(420, 560))),
            ('hold_still', receipt(left=20, top=115, width=200, height=330, blurred=True, frame_size=(420, 560))),
        ):
            with self.subTest(expected=expected):
                result = self.send('/alignment?portrait=true', photo).json()
                self.assertEqual(result['direction'], expected)

    def test_document_edges_win_over_larger_background_rectangle(self):
        frame = Image.new('RGB', (480, 640), '#323232')
        draw = ImageDraw.Draw(frame)
        draw.rectangle((16, 18, 455, 608), fill='#505050')
        draw.rectangle((50, 133, 220, 503), fill='white')
        draw.text((65, 157), 'TOTAL 45.00', fill='black', font=ImageFont.load_default(size=22))
        result = self.send('/alignment', encode(frame)).json()
        self.assertEqual(result['direction'], 'move_left')
        self.assertLess(result['metrics']['area_ratio'], 0.3)

    def test_two_equally_supported_documents_do_not_choose_a_direction(self):
        frame = Image.new('RGB', (480, 640), '#323232')
        draw = ImageDraw.Draw(frame)
        draw.rectangle((35, 140, 169, 498), fill='white')
        draw.rectangle((310, 140, 444, 498), fill='white')
        result = self.send('/alignment', encode(frame)).json()
        self.assertEqual(result['direction'], 'find_document')
        self.assertFalse(result['ready'])

    def test_local_ocr_reads_actual_pixels(self):
        response = self.send('/ocr', receipt())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertRegex(response.json()['text'], r'TOTAL\s+45\.00')

    def test_invalid_upload(self):
        self.assertEqual(self.send('/ocr', b'not an image').status_code, 400)
        oversized = b'0' * (512 * 1024 + 1)
        self.assertEqual(self.send('/alignment', oversized).status_code, 413)
        self.assertEqual(self.send('/alignment/vision', oversized).status_code, 413)

    def test_vision_uses_normalized_portrait(self):
        upright = Image.open(BytesIO(receipt(left=30, top=140, width=220, height=360, frame_size=(480, 640))))
        landscape = upright.transpose(Image.Transpose.ROTATE_90)
        with patch('app.vision_alignment._generate') as generate, patch('app.main.vision_alignment', VisionAlignment()):
            generate.return_value = framing_assessment()
            self.assertEqual(self.send('/alignment/vision', encode(landscape)).status_code, 422)
            generate.assert_not_called()
            response = self.send('/alignment/vision', encode(landscape, 6))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(generate.call_args.args[0].size, (480, 640))
        self.assertEqual(response.json()['alignment']['direction'], 'move_left')

    def test_vision_schema_rejects_unknown_and_impossible_values(self):
        for fields in (
            {'recommended_action': 'pan_left'}, {'confidence': 0.9}, {'document_detected': 'true'},
            {'ready_to_capture': True, 'recommended_action': 'ready'}, {'document_detected': False},
            {'too_close': True, 'too_far': True},
        ):
            with self.subTest(fields=fields), self.assertRaises(ValidationError):
                framing_assessment(**fields)

    def test_fusion_only_adds_corroborated_directions_without_local_geometry(self):
        left = Image.open(BytesIO(receipt(left=30, top=140, width=220, height=360, frame_size=(480, 640))))
        measured = analyze_frame(left)
        opposing = framing_assessment(horizontal_position='right', recommended_action='move_right')
        self.assertEqual(fuse_alignment(measured, opposing), (measured, False))
        unknown = analyze_frame(Image.new('RGB', (480, 640), '#232423'))
        for action, location in (
            ('move_left', {'horizontal_position': 'left'}), ('move_right', {'horizontal_position': 'right'}),
            ('move_up', {'vertical_position': 'above'}), ('move_down', {'vertical_position': 'below'}),
        ):
            with self.subTest(action=action):
                ai = framing_assessment(horizontal_position='center', recommended_action=action)
                self.assertEqual(fuse_alignment(unknown, ai), (unknown, False))
                hint, used = fuse_alignment(unknown, ai.model_copy(update=location))
                self.assertTrue(used)
                self.assertFalse(hint.ready)
                self.assertEqual(hint.direction, action)
        ready = framing_assessment(horizontal_position='center', recommended_action='ready', ready_to_capture=True)
        self.assertEqual(fuse_alignment(unknown, ready), (unknown, False))
        inverse = framing_assessment(recommended_action='move_right')
        self.assertEqual(fuse_alignment(unknown, inverse)[0].direction, 'move_left')
        ambiguous = framing_assessment(vertical_position='above')
        self.assertEqual(fuse_alignment(unknown, ambiguous), (unknown, False))

    def test_vision_failure_and_busy_keep_opencv_available(self):
        image = Image.open(BytesIO(receipt(left=30, top=140, width=220, height=360, frame_size=(480, 640))))
        for code, status in ((429, 'quota'), (504, 'timeout'), (502, 'unavailable')):
            service = VisionAlignment()
            with self.subTest(code=code), patch('app.vision_alignment._generate', side_effect=HTTPException(code)) as generate:
                for result in (service.assess(image), service.assess(image)):
                    self.assertEqual(result.vision_status, status)
                    self.assertEqual(result.alignment.direction, 'move_left')
                    self.assertEqual(result.source, 'opencv')
                    self.assertGreater(result.retry_after_ms, 0)
                generate.assert_called_once()
        with service._lock, patch('app.vision_alignment._generate') as generate:
            self.assertEqual(service.assess(image).vision_status, 'busy')
            generate.assert_not_called()

    @unittest.skipUnless(os.getenv('RUN_LIVE_GEMINI_TESTS') == '1', 'requires a live Gemini key and quota')
    def test_live_vision_alignment(self):
        photo = receipt(left=30, top=140, width=220, height=360, frame_size=(480, 640))
        baseline_start = perf_counter()
        baseline = self.send('/alignment', photo).json()
        baseline_ms = round((perf_counter() - baseline_start) * 1000)
        with patch('app.main.vision_alignment', VisionAlignment()):
            response = self.send('/alignment/vision', photo)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result['vision_status'], 'ok', response.text)
        self.assertTrue(result['assessment']['document_detected'])
        self.assertEqual(result['alignment']['direction'], baseline['direction'])
        print(f"Portrait left fixture: OpenCV {baseline_ms} ms, Gemini {result['vision_ms']} ms, "
              f"Gemini suggested {result['assessment']['recommended_action']}, fused {result['alignment']['direction']}")

    def test_missing_key_returns_error_instead_of_an_answer(self):
        with patch.dict(os.environ, {'GEMINI_API_KEY': ''}), patch('app.qa._env_file', Path('__missing__.env')):
            self.assertEqual(self.send('/analyze', receipt()).status_code, 503)
            self.assertEqual(self.send('/ask', receipt(), question='What is the total?').status_code, 503)

    @unittest.skipUnless(os.getenv('RUN_LIVE_GEMINI_TESTS') == '1', 'requires a live Gemini key and quota')
    def test_live_gemini_description(self):
        photo = receipt()
        recognized = self.send('/ocr', photo).json()['text']
        description = self.send('/analyze', photo, ocr_text=recognized)
        self.assertEqual(description.status_code, 200, description.text)
        self.assertTrue(description.json()['ai_generated'])
        self.assertTrue(description.json()['description'].strip())

    @unittest.skipUnless(os.getenv('RUN_LIVE_GEMINI_TESTS') == '1', 'requires a live Gemini key and quota')
    def test_live_gemini_answer(self):
        photo = receipt()
        recognized = self.send('/ocr', photo).json()['text']
        answer = self.send('/ask', photo, ocr_text=recognized, question='What is the printed total?')
        self.assertEqual(answer.status_code, 200, answer.text)
        self.assertTrue(answer.json()['ai_generated'])
        self.assertFalse(answer.json()['uncertain'])
        self.assertRegex(answer.json()['answer'], r'\b45(?:\.00)?\b')


if __name__ == '__main__':
    unittest.main()
