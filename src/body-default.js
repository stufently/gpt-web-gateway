// Express 5 (body-parser 2.x) leaves req.body undefined when the request carries
// no body or a content type no parser claimed; Express 4 always set it to {}.
// The routes read req.body.<field> directly, so without this a POST with no
// JSON body turned a clean 400 "prompt is required" into a 500 TypeError.
// Multipart routes are unaffected: multer replaces req.body with its own object.
function defaultBody(req, res, next) {
  if (req.body === undefined) req.body = {};
  next();
}

module.exports = { defaultBody };
