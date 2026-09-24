import app from './app';
import { env } from './config/env';
import { messages } from './constants/messages';
import { apiEndpoints } from './constants/serviceConfig';
import { createTables, seedData } from './db/migrate';
import { logger } from './utils/logger';

const startServer = async (): Promise<void> => {
  try {
    logger.info(messages.errors.databaseInitializing);
    await createTables();
    await seedData();
    logger.info(messages.errors.databaseInitialized);

    app.listen(env.port, () => {
      logger.info('========================================');
      logger.info(`  ${messages.service.title}`);
      logger.info(`  ${messages.service.started}`);
      logger.info(`  端口: ${env.port}`);
      logger.info(`  数据库端口: ${env.database.port}`);
      logger.info(`  环境: ${env.nodeEnv}`);
      logger.info('========================================');
      logger.info('API 端点:');
      apiEndpoints.forEach((endpoint) => logger.info(`  ${endpoint}`));
      logger.info('========================================');
    });
  } catch (error) {
    logger.error(messages.errors.serverStartFailed, error);
    process.exit(1);
  }
};

startServer();
