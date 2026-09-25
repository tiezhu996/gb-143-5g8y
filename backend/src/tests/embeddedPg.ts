// 仅用于本地验证：启动嵌入式 PostgreSQL（生产/Docker 仍使用独立数据库服务）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const EmbeddedPostgres = require('embedded-postgres').default as new (config: any) => any;

export const startEmbeddedPostgres = async (): Promise<any> => {
  const pg = new EmbeddedPostgres({
    databaseDir: '/tmp/embedded-pgdata-gb143',
    user: 'volunteer_user',
    password: 'volunteer_pass',
    port: 5743,
    persistent: true,
    initdbFlags: [],
    postgresFlags: [],
  });

  await pg.initialise();
  await pg.start();

  // 创建测试数据库（幂等）
  await pg.createDatabase('volunteer_db').catch(() => undefined);

  return pg;
};
