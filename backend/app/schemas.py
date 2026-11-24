from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Quality(BaseModel):
    clipped: bool = False
    blurred: bool = False
    too_small: bool = False
    tilted: bool = False
    too_close: bool = False


class FrameMetrics(BaseModel):
    center_x: float
    center_y: float
    area_ratio: float
    tilt_degrees: float
    sharpness: float
    corners: list[tuple[float, float]]
    boundary_score: float


class Alignment(BaseModel):
    detected: bool
    ready: bool
    direction: str
    message: str
    quality: Quality
    metrics: FrameMetrics | None = None
    frame_width: int
    frame_height: int


VisionAction = Literal[
    'move_left', 'move_right', 'move_up', 'move_down', 'move_closer', 'move_farther',
    'rotate_clockwise', 'rotate_counterclockwise', 'hold_still', 'ready', 'document_not_found', 'uncertain',
]


class VisionAssessment(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')

    document_detected: bool
    document_type: Literal['receipt', 'menu', 'notice', 'page', 'other', 'unknown']
    horizontal_position: Literal['left', 'center', 'right', 'unknown']
    vertical_position: Literal['above', 'center', 'below', 'unknown']
    document_fully_visible: bool
    too_close: bool
    too_far: bool
    blurry: bool
    tilted: bool
    recommended_action: VisionAction
    ready_to_capture: bool

    @model_validator(mode='after')
    def validate_geometry(self):
        if not self.document_detected and (self.document_fully_visible
                                          or self.recommended_action not in ('document_not_found', 'uncertain')):
            raise ValueError('An undetected document cannot support a corrective action.')
        if self.too_close and self.too_far:
            raise ValueError('Distance flags are inconsistent.')
        if self.ready_to_capture != (self.recommended_action == 'ready'):
            raise ValueError('Readiness and action disagree.')
        if self.ready_to_capture and (
            not self.document_detected or not self.document_fully_visible
            or self.horizontal_position != 'center' or self.vertical_position != 'center'
            or self.too_close or self.too_far or self.blurry or self.tilted
        ):
            raise ValueError('Readiness conflicts with framing evidence.')
        return self


VisionStatus = Literal['ok', 'disabled', 'busy', 'rate_limited', 'quota', 'timeout', 'unavailable']


class HybridAlignment(BaseModel):
    alignment: Alignment
    source: Literal['opencv', 'gemini'] = 'opencv'
    vision_status: VisionStatus
    vision_ms: int | None = None
    retry_after_ms: int | None = None
    assessment: VisionAssessment | None = None


class OcrResult(BaseModel):
    text: str
    warnings: list[str] = Field(default_factory=list)


class ModelDescription(BaseModel):
    description: str = Field(min_length=1)
    uncertain: bool


class Description(ModelDescription):
    warnings: list[str] = Field(default_factory=list)
    ai_generated: bool = True


class ModelAnswer(BaseModel):
    answer: str = Field(min_length=1)
    supporting_text: str = Field(description='An exact OCR quote when available, otherwise an empty string.')
    uncertain: bool


class Answer(ModelAnswer):
    ai_generated: bool = True
