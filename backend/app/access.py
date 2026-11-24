import os
import re
from hmac import compare_digest
from ipaddress import ip_address

from starlette.requests import HTTPConnection


_key_shape = re.compile(r'[A-Za-z0-9_-]{43,128}')


def access_failure(connection: HTTPConnection, *, allow_usb: bool = True) -> int | None:
    """Return the HTTP status for a denied request, or None for authorized access."""
    key = os.getenv('LENS_ACCESS_KEY', '')
    if not key and allow_usb and os.getenv('LENS_REMOTE_MODE') != '1':
        try:
            if connection.client and ip_address(connection.client.host).is_loopback:
                return None
        except ValueError:
            pass
        return 403
    if not _key_shape.fullmatch(key):
        return 503

    authorization = connection.headers.getlist('authorization')
    if len(authorization) == 1:
        scheme, _, supplied = authorization[0].partition(' ')
        if scheme.lower() == 'bearer' and _key_shape.fullmatch(supplied) and compare_digest(key, supplied):
            return None
    return 401
