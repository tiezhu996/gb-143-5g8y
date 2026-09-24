import dotenv from 'dotenv';

dotenv.config();

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toNumber(process.env.PORT, 3243),
  adminToken: process.env.ADMIN_TOKEN || 'admin-super-token-change-in-production',
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: toNumber(process.env.DB_PORT, 5743),
    name: process.env.DB_NAME || 'volunteer_db',
    user: process.env.DB_USER || 'volunteer_user',
    password: process.env.DB_PASSWORD || 'volunteer_pass',
  },
};
