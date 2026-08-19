// Optional app-level auth. When an API key is configured, protected routes
// require either `Authorization: Bearer <key>` or Basic auth with any username
// and the key as password (so OpenAI SDKs and `curl -u` both work). Kept as a
// pure check + thin middleware so the logic is unit-testable without Express.
const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Returns true when the Authorization header value grants access for apiKey.
// Scheme names are case-insensitive per RFC 7235.
function checkAuthHeader(header, apiKey) {
  if (!apiKey) return true;
  const value = String(header || '');
  const scheme = value.slice(0, value.indexOf(' ') === -1 ? value.length : value.indexOf(' ')).toLowerCase();
  const rest = value.slice(scheme.length + 1).trim();
  if (scheme === 'bearer') {
    return timingSafeEqualStr(rest, apiKey);
  }
  if (scheme === 'basic') {
    let decoded;
    try {
      decoded = Buffer.from(rest, 'base64').toString('utf8');
    } catch {
      return false;
    }
    const sep = decoded.indexOf(':');
    return sep !== -1 && timingSafeEqualStr(decoded.slice(sep + 1), apiKey);
  }
  return false;
}

// Express middleware enforcing checkAuthHeader. Responds with the project's
// uniform error shape on failure.
function createAuthMiddleware(apiKey) {
  return (req, res, next) => {
    if (checkAuthHeader(req.headers.authorization, apiKey)) return next();
    res.set('WWW-Authenticate', 'Basic realm="gpt-web-gateway"');
    return res.status(401).json({
      ok: false,
      error_kind: 'unauthorized',
      should_retry: false,
      error: { message: 'Missing or invalid API key', type: 'invalid_request_error' },
    });
  };
}

module.exports = { checkAuthHeader, createAuthMiddleware };
