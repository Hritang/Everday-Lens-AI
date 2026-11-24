from threading import Lock

import cv2
import numpy as np
from PIL import Image
from rapidocr import RapidOCR

from .schemas import OcrResult

_lock = Lock()
_engine: RapidOCR | None = None


def read_document(image: Image.Image) -> OcrResult:
    global _engine
    sample = image.copy()
    sample.thumbnail((2400, 2400))
    bgr = cv2.cvtColor(np.asarray(sample), cv2.COLOR_RGB2BGR)
    with _lock:
        if _engine is None:
            _engine = RapidOCR(params={
                'Global.log_level': 'warning',
                'EngineConfig.onnxruntime.intra_op_num_threads': 2,
                'EngineConfig.onnxruntime.inter_op_num_threads': 1,
            })
        result = _engine(bgr)

    lines = [line.strip() for line in (result.txts or ()) if line.strip()]
    if not lines:
        return OcrResult(text='', warnings=['No readable text found. Move closer and capture again.'])
    return OcrResult(text='\n'.join(lines))
