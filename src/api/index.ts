import 'dotenv/config';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { createTypesenseClient } from '../typesense.js';
import type { Address } from '../schema.js';

const SUSPICIOUS_UA =
  /sqlmap|nikto|nmap|masscan|zgrab|python-requests\/2\.[0-4]/i;

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

const client = createTypesenseClient();

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const apiKeys = new Set(
  (process.env.API_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

await app.register(helmet, { global: true });

await app.register(rateLimit, {
  max: 30,
  timeWindow: '1 minute',
  keyGenerator: (req) => {
    const key = (req.headers['x-api-key'] as string) ?? '';
    return key || req.ip;
  },
});

app.addHook('onRequest', (req, reply, done) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Headers', 'X-Api-Key, Content-Type');
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }

  // Let preflight requests through without auth
  if (req.method === 'OPTIONS') {
    reply.code(204).send();
    return;
  }

  // Block missing or suspicious user agents
  const ua = req.headers['user-agent'] ?? '';
  if (!ua || SUSPICIOUS_UA.test(ua)) {
    reply.code(400).send({ error: 'Bad request' });
    return;
  }

  if (
    apiKeys.size > 0 &&
    !apiKeys.has((req.headers['x-api-key'] as string) ?? '')
  ) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  done();
});

const querySchema = z.object({
  q: z.string().min(3).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

app.get<{ Querystring: { q?: string; limit?: string } }>(
  '/address',
  async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Invalid parameter q (min 3 characters)' });
    }

    const { q, limit } = parsed.data;

    try {
      const results = await client
        .collections<Address>('adresses')
        .documents()
        .search({
          q,
          query_by:
            'label,street_fr,street_nl,street_de,municipality_fr,municipality_nl,municipality_de',
          limit,
          num_typos: 1,
        });

      return results.hits?.map((h) => h.document) ?? [];
    } catch (err) {
      req.log.error(err, 'Typesense search error');
      return reply.code(500).send({ error: 'Search unavailable' });
    }
  },
);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
