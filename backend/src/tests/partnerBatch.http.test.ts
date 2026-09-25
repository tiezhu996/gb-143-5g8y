import dotenv from 'dotenv';
dotenv.config();

process.env.PORT = '3399';

import http from 'http';
import app from '../app';
import pool from '../db/pool';
import { startEmbeddedPostgres } from './embeddedPg';
import { createTables } from '../db/migrate';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-super-token-change-in-production';

const request = (method: string, path: string, body?: any, token = ADMIN_TOKEN): Promise<{ status: number; body: any }> => {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 3399,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : {} });
          } catch {
            reject(new Error(`Bad JSON: ${raw}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
};

let failures = 0;
const check = (name: string, cond: boolean, extra?: any): void => {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) {
    failures += 1;
    if (extra) console.log('  ', JSON.stringify(extra));
  }
};

const run = async (): Promise<void> => {
  const pg = await startEmbeddedPostgres();
  await createTables();

  const volunteer = await pool.query(`INSERT INTO volunteers(name) VALUES ('HTTP测试志愿者') RETURNING id`);
  const volunteerId = volunteer.rows[0].id;

  const server = app.listen(3399);
  await new Promise((r) => server.on('listening', r));

  try {
    const batchNo = `HTTP-${Date.now()}`;
    const payload = {
      batch_no: batchNo,
      partner_id: 'partner-http',
      records: [
        { org_record_no: 'H1', volunteer_id: volunteerId, service_type: 'education', duration_hours: 2, rating: 5 },
      ],
    };

    // 1) 首批 → 201
    const r1 = await request('POST', '/api/v1/service-records/partner-batches', payload);
    check('首批 HTTP 201', r1.status === 201, r1);
    check('首批 status=accepted', r1.body?.data?.status === 'accepted', r1.body);

    // 2) 原样重试 → 200 duplicate
    const r2 = await request('POST', '/api/v1/service-records/partner-batches', payload);
    check('重试 HTTP 200', r2.status === 200, r2);
    check('重试 status=duplicate', r2.body?.data?.status === 'duplicate', r2.body);

    // 3) 冲突 → 409
    const conflictPayload = JSON.parse(JSON.stringify(payload));
    conflictPayload.records[0].rating = 1;
    const r3 = await request('POST', '/api/v1/service-records/partner-batches', conflictPayload);
    check('冲突 HTTP 409', r3.status === 409, r3);
    check('冲突 status=conflict', r3.body?.data?.status === 'conflict', r3.body);
    check('冲突条目指明 rating 与新旧值',
      r3.body?.data?.conflicts?.[0]?.conflict_field === 'rating' &&
      r3.body?.data?.conflicts?.[0]?.existing_value === '5' &&
      r3.body?.data?.conflicts?.[0]?.received_value === '1',
      r3.body?.data?.conflicts);

    // 4) 无效数据（Joi 层）→ 400，不写
    const invalid = {
      batch_no: `${batchNo}-bad`,
      partner_id: 'partner-http',
      records: [
        { org_record_no: 'I1', volunteer_id: 'not-a-uuid', service_type: 'education', duration_hours: -1, rating: 9 },
      ],
    };
    const r4 = await request('POST', '/api/v1/service-records/partner-batches', invalid);
    check('无效请求 HTTP 400', r4.status === 400, r4);

    // 5) 批内重复 → 400
    const dup = {
      batch_no: `${batchNo}-dup`,
      partner_id: 'partner-http',
      records: [
        { org_record_no: 'D1', volunteer_id: volunteerId, service_type: 'education', duration_hours: 1, rating: 5 },
        { org_record_no: 'D1', volunteer_id: volunteerId, service_type: 'education', duration_hours: 1, rating: 5 },
      ],
    };
    const r5 = await request('POST', '/api/v1/service-records/partner-batches', dup);
    check('批内重复 HTTP 400', r5.status === 400 && r5.body.error.includes('重复'), r5.body);

    // 6) 未认证 → 401
    const r6 = await request('POST', '/api/v1/service-records/partner-batches', payload, 'bad-token');
    check('无有效令牌 HTTP 401', r6.status === 401, r6);

    // 7) 非管理员查批次 → 403
    const r7 = await request('GET', `/api/v1/admin/service-batches/${batchNo}`, undefined, `volunteer_${volunteerId}`);
    check('志愿者访问管理接口 HTTP 403', r7.status === 403, r7);

    // 8) 管理员查批次 → 200，含 attempts
    const r8 = await request('GET', `/api/v1/admin/service-batches/${batchNo}`);
    check('管理员查批次 HTTP 200', r8.status === 200, r8);
    check('返回历次来件 attempts', Array.isArray(r8.body?.data?.attempts) && r8.body.data.attempts.length === 3,
      r8.body?.data?.attempts?.map((a: any) => ({ no: a.attempt_no, accepted: a.accepted, duplicate: a.duplicate, conflict: a.conflict })));
    check('首批 accepted=1', r8.body?.data?.attempts?.[0]?.accepted === 1);

    // 9) 管理员批次列表
    const r9 = await request('GET', '/api/v1/admin/service-batches?page=1&page_size=10');
    check('批次列表 HTTP 200 且含目标批次',
      r9.status === 200 && r9.body?.data?.batches?.some((x: any) => x.batch_no === batchNo), r9.body);

    // 10) 不存在批次 → 404
    const r10 = await request('GET', '/api/v1/admin/service-batches/NO_SUCH_BATCH');
    check('不存在批次 HTTP 404', r10.status === 404, r10.body);

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  } finally {
    server.close();
    await pool.end();
    await pg.stop();
    process.exit(failures === 0 ? 0 : 1);
  }
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
