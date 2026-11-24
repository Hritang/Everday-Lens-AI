import logging
import os
from io import BytesIO
from time import perf_counter
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError

from .access import access_failure
from .alignment import analyze_frame
from .live import live_socket
from .ocr import read_document
from .qa import answer_question, describe
from .schemas import Alignment, Answer, Description, HybridAlignment, OcrResult
from .vision_alignment import VisionAlignment

app = FastAPI(title='Lens AI API', version='1.0.0')
app.add_api_websocket_route('/live', live_socket)
_log = logging.getLogger('uvicorn.error')
_max_photo_size = 8 * 1024 * 1024
_max_sample_size = 512 * 1024
_max_pixels = 24_000_000
_formats = {'image/jpeg': 'JPEG', 'image/png': 'PNG'}
Photo = Annotated[UploadFile, File()]
OcrText = Annotated[str, Form(max_length=12_000)]
vision_alignment = VisionAlignment()


@app.middleware('http')
async def check_access_and_upload_size(request: Request, call_next):
    if request.method != 'GET' or request.url.path != '/health':
        denied = access_failure(request, allow_usb=request.url.path != '/pair')
        if denied:
            message = 'Server pairing is not configured.' if denied == 503 else 'Pair this phone with the Lens AI server.'
            headers = {'Cache-Control': 'no-store'}
            if denied == 401:
                headers['WWW-Authenticate'] = 'Bearer'
            return JSONResponse({'detail': message}, status_code=denied, headers=headers)
    if request.method == 'POST' and request.url.path.rstrip('/') in {'/alignment', '/alignment/vision', '/ocr', '/analyze', '/ask'}:
        limit = _max_sample_size if request.url.path.startswith('/alignment') else _max_photo_size
        length = request.headers.get('content-length', '')
        if not length.isdecimal():
            return JSONResponse({'detail': 'Send a multipart upload with a content length.'}, status_code=411)
        if int(length) > limit + 64 * 1024:
            return JSONResponse({'detail': 'The image is too large. Retake the photo.'}, status_code=413)
    return await call_next(request)


def _decode(photo: UploadFile, byte_limit: int = _max_photo_size) -> Image.Image:
    expected_format = _formats.get(photo.content_type or '')
    if not expected_format:
        raise HTTPException(415, 'Only JPEG and PNG images are supported.')
    contents = photo.file.read(byte_limit + 1)
    if len(contents) > byte_limit:
        raise HTTPException(413, 'The image is too large. Retake the photo.')
    try:
        with Image.open(BytesIO(contents)) as source:
            if source.format != expected_format:
                raise HTTPException(415, 'The file does not match its image type.')
            if source.width * source.height > _max_pixels:
                raise HTTPException(413, 'Image dimensions are too large.')
            if min(source.size) < 64:
                raise HTTPException(400, 'The image is too small to read.')
            return ImageOps.exif_transpose(source).convert('RGB')
    except Image.DecompressionBombError:
        raise HTTPException(413, 'Image dimensions are too large.') from None
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(400, 'The photo could not be read. Retake the photo.') from None


@app.get('/health')
def health():
    return {'ok': True, 'status': 'ok'}


@app.post('/pair', status_code=204)
def pair():
    return Response(status_code=204, headers={'Cache-Control': 'no-store'})


@app.post('/alignment', response_model=Alignment)
def alignment(image: Photo, portrait: bool = False):
    start = perf_counter()
    decoded = _decode(image, _max_sample_size)
    if portrait and decoded.width >= decoded.height:
        raise HTTPException(422, 'The alignment frame needs to be upright in portrait.')
    result = analyze_frame(decoded)
    if os.getenv('ALIGNMENT_DEBUG') == '1':
        metrics = result.metrics
        box = center = offset = blur = None
        if metrics:
            xs, ys = zip(*metrics.corners)
            box = (min(xs), min(ys), max(xs), max(ys))
            center = (metrics.center_x, metrics.center_y)
            offset = (round(center[0] - 0.5, 4), round(center[1] - 0.5, 4))
            blur = metrics.sharpness
        _log.info('framing size=%dx%d box=%s center=%s offset=%s blur=%s clip=%s far=%s close=%s action=%s processing_ms=%.1f',
                  decoded.width, decoded.height, box, center, offset, blur, result.quality.clipped,
                  result.quality.too_small, result.quality.too_close, result.direction,
                  (perf_counter() - start) * 1000)
    return result


@app.post('/alignment/vision', response_model=HybridAlignment)
def alignment_vision(image: Photo):
    decoded = _decode(image, _max_sample_size)
    if decoded.width >= decoded.height:
        raise HTTPException(422, 'The alignment frame needs to be upright in portrait.')
    return vision_alignment.assess(decoded)


@app.post('/ocr', response_model=OcrResult)
def ocr(image: Photo):
    decoded = _decode(image)
    _log.info('OCR received normalized image %dx%d', decoded.width, decoded.height)
    try:
        return read_document(decoded)
    except Exception as exc:
        _log.warning('OCR engine unavailable: %s', type(exc).__name__)
        raise HTTPException(503, 'Text recognition is unavailable. Try again or ask Lens AI for a description.') from None


@app.post('/analyze', response_model=Description)
def analyze(image: Photo, ocr_text: OcrText = '', mode: Annotated[Literal['describe', 'summary'], Form()] = 'describe'):
    return describe(_decode(image), ocr_text, summary=mode == 'summary')


@app.post('/ask', response_model=Answer)
def ask(image: Photo, question: Annotated[str, Form(min_length=1, max_length=500)], ocr_text: OcrText = ''):
    if not question.strip():
        raise HTTPException(400, 'Ask a question about the document.')
    return answer_question(_decode(image), ocr_text, question.strip())
