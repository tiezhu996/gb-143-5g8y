import { Pool } from 'pg';
import { env } from '../config/env';
import { messages } from '../constants/messages';
import { logger } from '../utils/logger';

const pool = new Pool({
  host: env.database.host,
  port: env.database.port,
  database: env.database.name,
  user: env.database.user,
  password: env.database.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error(messages.errors.idleClient, err);
});

export default pool;
