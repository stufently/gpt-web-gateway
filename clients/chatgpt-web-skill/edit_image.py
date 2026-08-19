#!/usr/bin/env python3
"""ChatGPT Web API client — edit (and multipart-create) for Image 2.0.

Supports:
  - Standard edit:           edit_image.py <input> "<prompt>" <output> [flags]
  - Multipart create w/refs: edit_image.py --multipart-create "<prompt>" <output> --refs file1,file2 [flags]

Default thinking mode = instant (no thinking). Pass --thinking to opt in.

Flags:
  --aspect-ratio W:H
  --size WxH
  --thinking
  --web-search
  --refs PATH[,PATH]
  --format png|webp|jpg
  --quality low|medium|high
  --n N            (only meaningful for --multipart-create)
  --json

Env: CHATGPT_WEB_URL, CHATGPT_WEB_USER, CHATGPT_WEB_PASS
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.request
import uuid


def parse_args():
    p = argparse.ArgumentParser(allow_abbrev=False)
    p.add_argument('--multipart-create', action='store_true',
                   help='Call /v1/images/generations as multipart with reference_images[]')
    p.add_argument('input_or_prompt', nargs='?')
    p.add_argument('prompt_or_output', nargs='?')
    p.add_argument('output', nargs='?')
    p.add_argument('--aspect-ratio', dest='aspect_ratio', default=None)
    p.add_argument('--size', default=None)
    p.add_argument('--thinking', action='store_true')
    # DEPRECATED no-op (2026-07-10): GPT-5.6 auto-searches; API ignores web_search
    p.add_argument('--web-search', dest='web_search', action='store_true')
    p.add_argument('--refs', default='')
    p.add_argument('--format', dest='output_format', default=None)
    p.add_argument('--quality', default=None)
    p.add_argument('--n', type=int, default=1)
    p.add_argument('--json', dest='json_out', action='store_true')
    args = p.parse_args()
    if args.web_search:
        print('WARN: --web-search deprecated — ignored (GPT-5.6 auto-search)', file=sys.stderr)
    return args


def derive_size(args):
    """Derive a numeric size string for ChatGPT (it accepts size, not aspect_ratio)."""
    if args.size and 'x' in args.size:
        return args.size
    if args.aspect_ratio and ':' in args.aspect_ratio:
        mapping = {
            '1:1': '1024x1024',
            '4:3': '1536x1152',
            '3:4': '1152x1536',
            '16:9': '1536x864',
            '9:16': '864x1536',
            '3:2': '1536x1024',
            '2:3': '1024x1536',
            '3:1': '1536x512',
            '1:3': '512x1536',
        }
        return mapping.get(args.aspect_ratio, '1536x1024')
    return '1536x1024'


def thinking_mode_for(args):
    if args.thinking:
        return 'standard'
    return 'instant'


def build_multipart(fields, files):
    """Build multipart/form-data body. fields: dict[str,str|number|bool]. files: list[(field_name, filename, mime, bytes)]."""
    boundary = f'----ClaudeBoundary{uuid.uuid4().hex}'
    crlf = b'\r\n'
    parts = []

    for name, value in fields.items():
        if value is None or value == '':
            continue
        if isinstance(value, bool):
            value = 'true' if value else 'false'
        parts.append(f'--{boundary}'.encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        parts.append(b'')
        parts.append(str(value).encode())

    for field_name, filename, mime, file_bytes in files:
        parts.append(f'--{boundary}'.encode())
        parts.append(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"'.encode()
        )
        parts.append(f'Content-Type: {mime}'.encode())
        parts.append(b'')
        parts.append(file_bytes)

    parts.append(f'--{boundary}--'.encode())
    parts.append(b'')
    body = crlf.join(parts)
    return body, f'multipart/form-data; boundary={boundary}'


def read_file_with_resize(path, max_long_edge=2048, size_threshold_bytes=6 * 1024 * 1024):
    """Read file bytes. Image 2.0 handles up to 2K natively.
    Resize is best-effort: only triggered when file size exceeds size_threshold_bytes
    (default 6 MB) AND Docker imagemagick is available — otherwise we send original
    and rely on the ChatGPT-web side to handle it.
    """
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) > size_threshold_bytes:
        import subprocess, tempfile
        try:
            tmp_in = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(path)[1] or '.jpg')
            tmp_in.write(data); tmp_in.close()
            tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix='.jpg').name
            subprocess.run(
                ['docker', 'run', '--rm', '--entrypoint=', '-v', f'/tmp:/tmp',
                 'dpokidov/imagemagick',
                 'convert', tmp_in.name, '-resize', f'{max_long_edge}x{max_long_edge}>',
                 '-quality', '88', tmp_out],
                check=True, capture_output=True, timeout=60,
            )
            with open(tmp_out, 'rb') as f:
                data = f.read()
            os.unlink(tmp_in.name); os.unlink(tmp_out)
        except Exception as e:
            print(f'[edit_image] resize via docker failed: {e} — sending original', file=sys.stderr)
    return data


def http_post(url, body, content_type, credentials, timeout=600):
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            'Content-Type': content_type,
            'Authorization': f'Basic {credentials}',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def download(url, dest, credentials, timeout=120):
    """Download with size + magic-bytes sanity check."""
    url = url.replace('http://', 'https://')
    req = urllib.request.Request(url, headers={'Authorization': f'Basic {credentials}'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    if not data:
        raise RuntimeError(f'Empty body from {url}')
    if len(data) < 100:
        raise RuntimeError(f'Suspiciously small response from {url}: {len(data)} bytes')
    head = data[:12]
    is_png  = head.startswith(b'\x89PNG\r\n\x1a\n')
    is_jpeg = head.startswith(b'\xff\xd8\xff')
    is_webp = head[:4] == b'RIFF' and head[8:12] == b'WEBP'
    is_gif  = head[:6] in (b'GIF87a', b'GIF89a')
    if not (is_png or is_jpeg or is_webp or is_gif):
        raise RuntimeError(f'Response from {url} does not look like an image (head bytes: {head!r})')
    with open(dest, 'wb') as f:
        f.write(data)


def main():
    args = parse_args()

    api_url = os.environ.get('CHATGPT_WEB_URL', '')
    api_user = os.environ.get('CHATGPT_WEB_USER', '')
    api_pass = os.environ.get('CHATGPT_WEB_PASS', '')
    if not (api_url and api_user and api_pass):
        print('ERROR: CHATGPT_WEB_URL, CHATGPT_WEB_USER, CHATGPT_WEB_PASS must be set', file=sys.stderr)
        sys.exit(1)
    credentials = base64.b64encode(f'{api_user}:{api_pass}'.encode()).decode()

    refs = []
    if args.refs:
        for ref_path in args.refs.split(','):
            ref_path = ref_path.strip()
            if not ref_path:
                continue
            with open(ref_path, 'rb') as f:
                ref_bytes = f.read()
            mime = mimetypes.guess_type(ref_path)[0] or 'image/png'
            refs.append(('reference_images', os.path.basename(ref_path), mime, ref_bytes))

    if args.multipart_create:
        prompt = args.input_or_prompt
        output = args.prompt_or_output
        if not prompt or not output:
            print('Usage: --multipart-create "<prompt>" <output> --refs file1,file2 [...]', file=sys.stderr)
            sys.exit(1)
        size = derive_size(args)
        fields = {
            'prompt': prompt,
            'n': args.n,
            'thinking_mode': thinking_mode_for(args),
            'thinking': args.thinking,
            'aspect_ratio': args.aspect_ratio or '',
            'size': size,
            'output_format': args.output_format or '',
            'quality': args.quality or '',
        }
        body, ct = build_multipart(fields, refs)
        url = f'{api_url}/v1/images/generations'
        code, raw = http_post(url, body, ct, credentials, timeout=600)
        handle_response(code, raw, output, args, credentials, multi=True)
        return

    input_path = args.input_or_prompt
    prompt = args.prompt_or_output
    output = args.output
    if not (input_path and prompt and output):
        print('Usage: edit_image.py <input> "<prompt>" <output> [flags]', file=sys.stderr)
        sys.exit(1)

    file_bytes = read_file_with_resize(input_path, max_long_edge=2048)
    mime = mimetypes.guess_type(input_path)[0] or 'image/jpeg'
    filename = os.path.basename(input_path)

    files = [('image', filename, mime, file_bytes)] + refs
    size = derive_size(args)
    fields = {
        'prompt': prompt,
        'n': 1,
        'thinking_mode': thinking_mode_for(args),
        'thinking': args.thinking,
        'aspect_ratio': args.aspect_ratio or '',
        'size': size,
        'output_format': args.output_format or '',
        'quality': args.quality or '',
    }
    body, ct = build_multipart(fields, files)
    url = f'{api_url}/v1/images/edits'
    code, raw = http_post(url, body, ct, credentials, timeout=600)
    handle_response(code, raw, output, args, credentials, multi=False)


def handle_response(code, raw, output, args, credentials, multi=False):
    # API v1.2.6+ structured: { ok, error_kind, should_retry, model_message, error:{...} }
    # Exit codes:
    #   0 success
    #   1 generic / timeout / server_error (retry-возможно)
    #   2 rate_limit / queue_full
    #   3 refused / policy_violation (НЕ retry — менять промпт)
    #   4 login_failed (auth)
    try:
        parsed = json.loads(raw) if raw else {}
    except Exception:
        parsed = {}
    kind = parsed.get('error_kind') or ''
    model_msg = parsed.get('model_message') or ''
    should_retry = parsed.get('should_retry')
    err = parsed.get('error') if isinstance(parsed.get('error'), dict) else {}
    msg = err.get('message') or ''

    if code == 422:
        label = 'POLICY' if kind == 'policy_violation' else 'REFUSED'
        print(f'{label}: {msg or "content refused"}', file=sys.stderr)
        if model_msg:
            print(f'  model_message: {model_msg[:300]}', file=sys.stderr)
        print(f'  hint: смените промпт; should_retry={should_retry}', file=sys.stderr)
        sys.exit(3)

    if code == 429:
        retry_after = err.get('retry_after')
        if retry_after:
            mins = (retry_after + 59) // 60
            print(f'RATE_LIMITED: {msg or "Rate limited"}. Retry after {mins} min ({retry_after}s). kind={kind or "rate_limit"}', file=sys.stderr)
        else:
            print(f'RATE_LIMITED: {msg or "Server busy"}. kind={kind or "rate_limit"}', file=sys.stderr)
        sys.exit(2)

    if code == 503:
        print(f'LOGIN_FAILED: {msg or "ChatGPT Web auth failed"}. Требуется ручная проверка credentials.', file=sys.stderr)
        sys.exit(4)

    if code == 504:
        print(f'TIMEOUT: {msg or "generation exceeded budget"}. Можно попробовать другой промпт или Runware fallback.', file=sys.stderr)
        sys.exit(1)

    if code >= 500:
        print(f'ERROR: Server error (HTTP {code}, kind={kind or "server_error"}): {msg or "unknown"}', file=sys.stderr)
        sys.exit(1)

    if code >= 400:
        print(f'ERROR: HTTP {code}, kind={kind or "unknown"}: {(msg or raw.decode("utf-8", "ignore")[:300])}', file=sys.stderr)
        sys.exit(1)

    try:
        result = json.loads(raw)
    except Exception:
        print(f'ERROR: Invalid JSON response: {raw[:300]}', file=sys.stderr)
        sys.exit(1)

    data = result.get('data') or []
    if not data:
        print(f'ERROR: No image data: {result}', file=sys.stderr)
        sys.exit(1)

    out_paths = []
    for i, item in enumerate(data):
        url = item.get('url')
        if not url:
            continue
        if i == 0:
            target = output
        else:
            base, ext = os.path.splitext(output)
            target = f'{base}_{i + 1}{ext}'
        download(url, target, credentials, timeout=180)
        out_paths.append(target)

    if args.json_out:
        print(json.dumps({
            'ok': True,
            'files': out_paths,
            'applied': result.get('applied', {}),
        }))
    else:
        for p in out_paths:
            size_b = os.path.getsize(p)
            print(f'OK: {p} ({size_b} bytes)')


if __name__ == '__main__':
    main()
