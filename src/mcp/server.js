/**
 * ForkMind MCP server.
 *
 * Exposes the local `.forkmind/` conversation history to AI agents over the
 * Model Context Protocol (stdio transport). An agent can query its own past
 * turns — recent activity, the lineage that led to a node, sibling branches,
 * or a text search — to self-correct during long multi-step tasks.
 *
 * Run:  forkmind mcp        (or:  node bin/forkmind-mcp.js)
 *
 * The MCP SDK is ESM-only; this file is CommonJS, so we load it via dynamic
 * import() inside an async bootstrap.
 *
 * IMPORTANT: stdio transport owns stdout for the protocol. NEVER console.log
 * here — diagnostics must go to stderr (console.error) or they corrupt the
 * JSON-RPC stream.
 */
const {
  readNode,
  readAllNodes,
  getLineage,
  getChildren,
  searchNodes,
} = require('../storage/engine');
const { userPreview, assistantText, clip } = require('../lib/extract');
const capsules = require('../context/engine');

// ---- compact serializers (keep agent token cost low) ----

/** One-line-ish compact view of a node for lists. */
function compact(node) {
  return {
    id: node.id,
    parentId: node.parentId,
    provider: node.meta && node.meta.provider,
    model: node.request && node.request.model,
    timestamp: node.timestamp,
    user: clip(userPreview(node.request)),
    assistant: clip(assistantText(node.response)),
    childCount: Array.isArray(node.children) ? node.children.length : 0,
  };
}

/** Full view for a single node (used by get_node / lineage detail). */
function full(node) {
  return {
    id: node.id,
    parentId: node.parentId,
    meta: node.meta,
    timestamp: node.timestamp,
    request: node.request,
    response: node.response,
    children: node.children,
  };
}

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/**
 * Boot the MCP server on stdio. Resolves when connected.
 */
async function startMcp() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');

  const server = new McpServer({ name: 'forkmind', version: '0.3.3' });

  // --- recent activity ---
  server.registerTool(
    'forkmind_recent',
    {
      title: 'Recent ForkMind nodes',
      description:
        'List the most recent captured LLM turns (newest first), compact. ' +
        'Use to recall what was just tried.',
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
    },
    async ({ limit = 10 }) => {
      const nodes = readAllNodes()
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, limit)
        .map(compact);
      return text({ count: nodes.length, nodes });
    }
  );

  // --- single node, full detail ---
  server.registerTool(
    'forkmind_get_node',
    {
      title: 'Get a ForkMind node',
      description: 'Fetch one node by id with full request + response payloads.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const node = readNode(id);
      if (!node) return text({ error: `node ${id} not found` });
      return text(full(node));
    }
  );

  // --- lineage: the conversation path that led to a node ---
  server.registerTool(
    'forkmind_lineage',
    {
      title: 'Node lineage (root → node)',
      description:
        'Return the full conversation path from the root to the given node — ' +
        'the exact context that produced it. Use to understand how a state was reached.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const chain = getLineage(id);
      if (!chain.length) return text({ error: `node ${id} not found` });
      return text({ depth: chain.length, path: chain.map(compact) });
    }
  );

  // --- branches off a node ---
  server.registerTool(
    'forkmind_children',
    {
      title: 'Child branches of a node',
      description:
        'List the alternative continuations (branches) that fork from a node. ' +
        'Use to compare what different prompts/params produced from the same point.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const kids = getChildren(id).map(compact);
      return text({ count: kids.length, children: kids });
    }
  );

  // --- text search ---
  server.registerTool(
    'forkmind_search',
    {
      title: 'Search ForkMind history',
      description:
        'Case-insensitive substring search across all captured requests/responses. ' +
        'Use to find prior attempts mentioning a term, error, or tool.',
      inputSchema: {
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async ({ query, limit = 10 }) => {
      const hits = searchNodes(query).slice(0, limit).map(compact);
      return text({ query, count: hits.length, results: hits });
    }
  );

  // --- tree stats ---
  server.registerTool(
    'forkmind_stats',
    {
      title: 'ForkMind tree stats',
      description: 'Summary of the conversation tree: totals, roots, leaves, providers.',
      inputSchema: {},
    },
    async () => {
      const nodes = readAllNodes();
      const roots = nodes.filter((n) => !n.parentId);
      const leaves = nodes.filter((n) => !n.children || n.children.length === 0);
      const providers = [...new Set(nodes.map((n) => n.meta && n.meta.provider).filter(Boolean))];
      return text({
        total: nodes.length,
        roots: roots.length,
        leaves: leaves.length,
        providers,
      });
    }
  );

  // ---- context capsules: save context as an encrypted DAG, drop it from the
  // window, restore on demand ----

  server.registerTool(
    'forkmind_context_save',
    {
      title: 'Save a context capsule',
      description:
        'Offload conversation context into an immutable, encrypted DAG on disk. ' +
        'Pass the items to archive plus a short digest YOU write (the retrieval ' +
        'key you keep in your window; omit for private capsules). After the id ' +
        'comes back, verify with forkmind_context_digest, THEN drop the material ' +
        'from your working context — never before.',
      inputSchema: {
        title: z.string(),
        items: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
        digest: z.string().optional(),
        sourceNodeIds: z.array(z.string()).optional(),
      },
    },
    async ({ title, items, digest, sourceNodeIds }) => {
      try {
        return text(
          capsules.saveCapsule({ title, items, digest: digest || null, sourceNodeIds })
        );
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  server.registerTool(
    'forkmind_context_list',
    {
      title: 'List context capsules',
      description:
        'Compact list of saved capsules (title, digest, size, age). Optional ' +
        'substring filter over title + digest.',
      inputSchema: { q: z.string().optional() },
    },
    async ({ q }) => {
      const list = capsules.listCapsules({ q }).map((c) => ({
        id: c.id,
        title: c.title,
        digest: c.digest ? clip(c.digest) : null,
        bytes: c.bytes,
        createdAt: c.createdAt,
        segments: c.dag.segments.length,
      }));
      return text({ count: list.length, capsules: list });
    }
  );

  server.registerTool(
    'forkmind_context_digest',
    {
      title: 'Capsule digest + segment map',
      description:
        'Cheap probe: full digest and DAG structure for one capsule, no ' +
        'decryption of content. Use before restoring to decide whether you ' +
        'need the whole capsule or one segment. Also serves as the durability ' +
        'check after a save, before you compact your window.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const d = capsules.getDigest(id);
      if (!d) return text({ error: `capsule ${id} not found` });
      return text(d);
    }
  );

  server.registerTool(
    'forkmind_context_restore',
    {
      title: 'Restore capsule content',
      description:
        'Decrypt and return capsule content (integrity-verified first). Pass ' +
        'segmentIds for a partial restore — pull back only what you need.',
      inputSchema: { id: z.string(), segmentIds: z.array(z.string()).optional() },
    },
    async ({ id, segmentIds }) => {
      try {
        if (segmentIds && segmentIds.length) {
          return text({ id, items: capsules.readSegments(id, segmentIds) });
        }
        return text(capsules.readCapsule(id));
      } catch (err) {
        return text({ error: err.message, code: err.code });
      }
    }
  );

  server.registerTool(
    'forkmind_context_forget',
    {
      title: 'Forget a capsule (crypto-shred)',
      description:
        'IRREVERSIBLY destroy a capsule: its encryption key is shredded and the ' +
        'id tombstoned. You must echo the capsule id in `confirm`. Only call ' +
        'when the user explicitly asks to forget.',
      inputSchema: { id: z.string(), confirm: z.string() },
    },
    async ({ id, confirm }) => {
      try {
        return text(capsules.forgetCapsule(id, confirm));
      } catch (err) {
        return text({ error: err.message, code: err.code });
      }
    }
  );

  server.registerTool(
    'forkmind_context_replicas',
    {
      title: 'Capsule replica health (RAID)',
      description:
        'Status of redundant capsule storage: each replica target with ' +
        'reachability and coverage. Optionally sync (push all capsules + ' +
        'propagate tombstones) before reporting.',
      inputSchema: { sync: z.boolean().optional() },
    },
    async ({ sync }) => {
      const result = {};
      if (sync) result.sync = capsules.replicasSync();
      result.replicas = capsules.replicasStatus();
      return text(result);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — never stdout.
  console.error('[forkmind] MCP server ready on stdio');
}

module.exports = { startMcp, compact, full };
