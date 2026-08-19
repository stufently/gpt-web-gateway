// Pure conversation-trimming logic — no Playwright, no DOM.
//
// ChatGPT loads an entire conversation via GET /backend-api/conversation/{id}.
// For very long chats the returned `mapping` can contain thousands of message
// nodes; rendering all of them is what makes long chats freeze the tab (and, for
// this gateway, slows every multi-turn request). We keep only the last N messages
// on the active path and rewrite the mapping into a simple linear chain, which is
// enough for ChatGPT to render and keep working.
//
// Ported from megamen32/chatgpt-multi (src/lib/conversation-trim.js), which in
// turn adapted the open-source "ChatGPT Performance Long Chats" extension. The
// extension patches window.fetch; we apply the same transform server-side via
// Playwright's page.route() (see src/chatgpt.js, CONVERSATION_TRIM_LIMIT).

function isMessageNode(node) {
  const msg = node && node.message;
  const role = msg && msg.author && msg.author.role;
  return !!(node && node.id && msg && msg.content && (role === 'user' || role === 'assistant' || role === 'tool'));
}

function collectPathToRoot(mapping, startId) {
  const ids = [];
  const seen = new Set();
  let currentId = startId;
  while (currentId && mapping[currentId] && !seen.has(currentId)) {
    seen.add(currentId);
    ids.push(currentId);
    currentId = mapping[currentId].parent || null;
  }
  return ids;
}

/**
 * @param {object} data  Parsed conversation JSON from the backend.
 * @param {number} keepCount  How many trailing messages to keep.
 * @returns {object|null} A trimmed clone, or null when no trimming is needed
 *                        (caller should then pass through the original).
 */
function trimConversationData(data, keepCount) {
  if (!data || typeof data !== 'object') return null;
  if (!data.mapping || typeof data.mapping !== 'object') return null;
  if (!data.current_node) return null;
  if (!Number.isFinite(keepCount) || keepCount <= 0) return null;

  const mapping = data.mapping;
  const messageNodes = Object.values(mapping).filter(isMessageNode);
  if (messageNodes.length <= keepCount) return null;

  const pathIds = collectPathToRoot(mapping, data.current_node);
  const orderedMessages = pathIds
    .map((id) => mapping[id])
    .filter(isMessageNode)
    .reverse();

  const keptMessages = orderedMessages.slice(-keepCount);
  if (!keptMessages.length) return null;

  const rootId = data.root || 'root';
  const newMapping = {
    [rootId]: { id: rootId, parent: null, children: [], message: null },
  };

  let prevId = rootId;
  for (const node of keptMessages) {
    const id = node.id;
    newMapping[id] = Object.assign({}, node, { parent: prevId, children: [] });
    newMapping[prevId].children.push(id);
    prevId = id;
  }

  return Object.assign({}, data, {
    mapping: newMapping,
    current_node: prevId,
    root: rootId,
  });
}

module.exports = { trimConversationData, isMessageNode, collectPathToRoot };
