import dotenv from 'dotenv';
dotenv.config();

import pool from '../db/pool';
import { startEmbeddedPostgres } from './embeddedPg';
import { createTables } from '../db/migrate';
import { createVolunteer } from '../services/volunteerManager';
import { uploadPartnerBatch, getBatchByNo, listBatches } from '../services/partnerBatchService';
import type { PartnerBatchUploadInput } from '../types';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({ name, passed: condition, error: condition ? undefined : error, details });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

let volunteerAId = '';
let volunteerBId = '';

const makeBatch = (suffix: string, records: any[]): PartnerBatchUploadInput => ({
  batch_no: `BATCH-${suffix}`,
  partner_id: 'partner-org-1',
  records,
});

const record = (orgNo: string, volunteerId: string, overrides: any = {}) => ({
  org_record_no: orgNo,
  volunteer_id: volunteerId,
  service_type: 'community_service',
  duration_hours: 2,
  rating: 5,
  is_no_show: false,
  description: `记录${orgNo}`,
  ...overrides,
});

const getVolunteer = async (id: string) => {
  const r = await pool.query('SELECT * FROM volunteers WHERE id = $1', [id]);
  return r.rows[0];
};

const countServiceRecords = async (batchNo: string) => {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM service_records WHERE batch_no = $1', [batchNo]);
  return r.rows[0].c;
};

const countPointsLogs = async (batchNo: string) => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM points_logs WHERE reason LIKE '%批次${batchNo}%'`,
    []
  );
  return r.rows[0].c;
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  合作机构批量上传幂等性 - 验证用例');
  console.log('========================================\n');

  const pg = await startEmbeddedPostgres();
  console.log('嵌入式 PostgreSQL 已启动');

  try {
    await createTables();

    const va = await createVolunteer('批量测试志愿者A', '13900010001', 'batcha@example.com');
    volunteerAId = va.data!.id;
    const vb = await createVolunteer('批量测试志愿者B', '13900010002', 'batchb@example.com');
    volunteerBId = vb.data!.id;

    // -------------------------------------------------------------------------
    console.log('\n--- 用例1: 首批正常上传 → 全部新增、积分入账 ---');
    const s1 = randomSuffix();
    const batch1 = makeBatch(s1, [
      record('R-001', volunteerAId),
      record('R-002', volunteerAId, { service_type: 'medical_assist', duration_hours: 3, rating: 4 }),
      record('R-003', volunteerBId),
    ]);
    const first = await uploadPartnerBatch(batch1);
    assert('首批返回 success', first.success === true, '首批应成功', first);
    assert('首批状态为 accepted', first.data?.status === 'accepted', `实际 ${first.data?.status}`);
    assert('首批 accepted_count=3', first.data?.accepted_count === 3, undefined, first.data);
    assert('HTTP 语义：首批新增 3 条服务记录', (await countServiceRecords(batch1.batch_no)) === 3);

    const volAAfter1 = await getVolunteer(volunteerAId);
    const pointsAfterFirst = volAAfter1.total_points;
    const servicesAfterFirst = volAAfter1.service_count;
    assert('志愿者A 积分已增加', pointsAfterFirst > 0, `实际 ${pointsAfterFirst}`);
    assert('志愿者A 服务次数=2', servicesAfterFirst === 2, `实际 ${servicesAfterFirst}`);
    const logsAfterFirst = await countPointsLogs(batch1.batch_no);
    assert('首批写入 3 条积分流水', logsAfterFirst === 3, `实际 ${logsAfterFirst}`);

    // -------------------------------------------------------------------------
    console.log('\n--- 用例2: 同批原样重试 → 已接收，累计不变，无重复流水 ---');
    const retry1 = await uploadPartnerBatch(JSON.parse(JSON.stringify(batch1)));
    assert('重试返回 success', retry1.success === true, undefined, retry1);
    assert('重试状态为 duplicate', retry1.data?.status === 'duplicate', `实际 ${retry1.data?.status}`);
    assert('重试 duplicate_count=3', retry1.data?.duplicate_count === 3, undefined, retry1.data);
    const volAAfter2 = await getVolunteer(volunteerAId);
    assert('积分累计不变', volAAfter2.total_points === pointsAfterFirst,
      `${volAAfter2.total_points} vs ${pointsAfterFirst}`);
    assert('服务次数不变', volAAfter2.service_count === servicesAfterFirst,
      `${volAAfter2.service_count} vs ${servicesAfterFirst}`);
    assert('服务记录仍是 3 条', (await countServiceRecords(batch1.batch_no)) === 3);
    assert('积分流水仍是 3 条', (await countPointsLogs(batch1.batch_no)) === 3);

    // 再重试一次，确认 request_count 累计
    const retry2 = await uploadPartnerBatch(JSON.parse(JSON.stringify(batch1)));
    assert('第三次重试仍为 duplicate', retry2.data?.status === 'duplicate');
    const adminView1b = await getBatchByNo(batch1.batch_no);
    assert('来件次数累计为 3（首批+2次重试）', adminView1b.data?.batch.request_count === 3,
      `实际 ${adminView1b.data?.batch.request_count}`);

    // -------------------------------------------------------------------------
    console.log('\n--- 用例3: 同号改时长 → 整批拒绝、指出冲突条目、既有数据保持可查 ---');
    const conflicting = makeBatch(s1, [
      record('R-001', volunteerAId),
      record('R-002', volunteerAId, { service_type: 'medical_assist', duration_hours: 5, rating: 4 }),
      record('R-003', volunteerBId),
    ]);
    const conflictResp = await uploadPartnerBatch(conflicting);
    assert('冲突返回 success=true 携带 conflict 状态', conflictResp.success === true, undefined, conflictResp);
    assert('冲突状态为 conflict', conflictResp.data?.status === 'conflict', `实际 ${conflictResp.data?.status}`);
    assert('冲突条目数=1', conflictResp.data?.conflict_count === 1, undefined, conflictResp.data);
    const c0 = conflictResp.data?.conflicts?.[0];
    assert('冲突条目指向 R-002', c0?.org_record_no === 'R-002', undefined, c0);
    assert('冲突字段为 duration_hours', c0?.conflict_field === 'duration_hours', undefined, c0);
    assert('冲突字段有中文说明', c0?.conflict_field_label === '服务时长', undefined, c0);
    assert('既有值 3.00 可查', c0?.existing_value === '3.00', undefined, c0);
    assert('来件值 5.00 可查', c0?.received_value === '5.00', undefined, c0);
    const volAAfter3 = await getVolunteer(volunteerAId);
    assert('冲突后积分不变', volAAfter3.total_points === pointsAfterFirst,
      `${volAAfter3.total_points} vs ${pointsAfterFirst}`);
    assert('冲突后服务次数不变', volAAfter3.service_count === servicesAfterFirst);
    assert('冲突后服务记录仍是 3 条', (await countServiceRecords(batch1.batch_no)) === 3);
    assert('冲突后积分流水仍是 3 条', (await countPointsLogs(batch1.batch_no)) === 3);

    console.log('  3.1 改服务类型 → 冲突');
    const typeConflict = makeBatch(s1, [
      record('R-001', volunteerAId, { service_type: 'education' }),
      record('R-002', volunteerAId, { service_type: 'medical_assist', duration_hours: 3, rating: 4 }),
      record('R-003', volunteerBId),
    ]);
    const tc = await uploadPartnerBatch(typeConflict);
    assert('类型冲突被识别', tc.data?.status === 'conflict' && tc.data?.conflicts?.[0]?.conflict_field === 'service_type',
      undefined, tc.data);

    console.log('  3.2 改评分 → 冲突');
    const ratingConflict = makeBatch(s1, [
      record('R-001', volunteerAId),
      record('R-002', volunteerAId, { service_type: 'medical_assist', duration_hours: 3, rating: 2 }),
      record('R-003', volunteerBId),
    ]);
    const rc = await uploadPartnerBatch(ratingConflict);
    assert('评分冲突被识别', rc.data?.status === 'conflict' && rc.data?.conflicts?.[0]?.conflict_field === 'rating',
      undefined, rc.data);

    console.log('  3.2b 条目集合变化（多一条/少一条）→ 冲突且逐条指出');
    const shrunken = makeBatch(s1, [
      record('R-001', volunteerAId),
      record('R-002', volunteerAId, { service_type: 'medical_assist', duration_hours: 3, rating: 4 }),
    ]);
    const shrunkResp = await uploadPartnerBatch(shrunken);
    const shrunkFields = (shrunkResp.data?.conflicts ?? []).map((c) => c.conflict_field);
    assert('少条目识别为 missing_in_payload',
      shrunkResp.data?.status === 'conflict' && shrunkFields.includes('missing_in_payload'),
      undefined, shrunkResp.data);
    const shrunkView = await getBatchByNo(batch1.batch_no);
    const shrunkAttempt = shrunkView.data?.attempts.find((a: any) =>
      a.items.some((i: any) => i.conflict_field === 'missing_in_payload'));
    assert('少条目的 conflict 明细也留痕（含缺失条目行）',
      !!shrunkAttempt && shrunkAttempt.conflict >= 1 &&
      shrunkAttempt.items.some((i: any) => i.org_record_no === 'R-003' && i.conflict_field === 'missing_in_payload'),
      undefined, shrunkAttempt);

    const expanded = makeBatch(s1, [
      record('R-001', volunteerAId),
      record('R-002', volunteerAId, { service_type: 'medical_assist', duration_hours: 3, rating: 4 }),
      record('R-003', volunteerBId),
      record('R-004', volunteerBId),
    ]);
    const expandedResp = await uploadPartnerBatch(expanded);
    const expandedFields = (expandedResp.data?.conflicts ?? []).map((c) => c.conflict_field);
    assert('多条目识别为 missing_existing',
      expandedResp.data?.status === 'conflict' && expandedFields.includes('missing_existing'),
      undefined, expandedResp.data);

    console.log('  3.3 冲突后再发原样 → 仍可识别为已接收，既有累计依旧不变');
    const backToNormal = await uploadPartnerBatch(JSON.parse(JSON.stringify(batch1)));
    assert('纠正后重发状态为 duplicate', backToNormal.data?.status === 'duplicate',
      `实际 ${backToNormal.data?.status}`, backToNormal.data);
    const volAAfter33 = await getVolunteer(volunteerAId);
    assert('积分依旧不变', volAAfter33.total_points === pointsAfterFirst);
    assert('服务记录依旧 3 条', (await countServiceRecords(batch1.batch_no)) === 3);
    assert('积分流水依旧 3 条', (await countPointsLogs(batch1.batch_no)) === 3);

    // -------------------------------------------------------------------------
    console.log('\n--- 用例4: 坏数据（志愿者不存在）→ 一条也不写 ---');
    const s4 = randomSuffix();
    const badBatch = makeBatch(s4, [
      record('X-1', volunteerAId),
      record('X-2', '00000000-0000-0000-0000-000000000000'),
    ]);
    const badResp = await uploadPartnerBatch(badBatch);
    assert('坏数据批次返回 success=false', badResp.success === false, undefined, badResp);
    assert('提示问题条目 X-2', badResp.error?.includes('X-2') === true, undefined, badResp);
    assert('没有写入任何服务记录', (await countServiceRecords(badBatch.batch_no)) === 0);
    assert('批次号被释放，管理员查不到', (await getBatchByNo(badBatch.batch_no)).success === false);
    const volAAfter4 = await getVolunteer(volunteerAId);
    assert('志愿者A 积分未变', volAAfter4.total_points === pointsAfterFirst);

    console.log('  4.1 批次内机构记录号重复 → 一条也不写');
    const s41 = randomSuffix();
    const dupInBatch = makeBatch(s41, [
      record('D-1', volunteerAId),
      record('D-1', volunteerBId),
    ]);
    const dupResp = await uploadPartnerBatch(dupInBatch);
    assert('批内重复被拒绝', dupResp.success === false, undefined, dupResp);
    assert('批内重复零写入', (await countServiceRecords(dupInBatch.batch_no)) === 0);

    console.log('  4.2 低信用志愿者 → 整批拒绝，一条也不写');
    const s42 = randomSuffix();
    await pool.query('UPDATE volunteers SET credit_score = 10 WHERE id = $1', [volunteerBId]);
    const creditBad = makeBatch(s42, [
      record('C-1', volunteerAId),
      record('C-2', volunteerBId),
    ]);
    const creditResp = await uploadPartnerBatch(creditBad);
    assert('低信用批次被拒绝', creditResp.success === false, undefined, creditResp);
    assert('低信用提示条目 C-2', creditResp.error?.includes('C-2') === true);
    assert('低信用批次零写入', (await countServiceRecords(creditBad.batch_no)) === 0);
    await pool.query('UPDATE volunteers SET credit_score = 100 WHERE id = $1', [volunteerBId]);

    // -------------------------------------------------------------------------
    console.log('\n--- 用例5: 两路请求同时到达 → 只留一份记录与一套积分流水 ---');
    const s5 = randomSuffix();
    const concurrentBatch = makeBatch(s5, [
      record('P-1', volunteerAId, { service_type: 'education', duration_hours: 1 }),
      record('P-2', volunteerBId, { service_type: 'education', duration_hours: 1 }),
    ]);
    const before5 = (await getVolunteer(volunteerAId)).total_points;
    const beforeB5 = (await getVolunteer(volunteerBId)).total_points;
    const [r5a, r5b] = await Promise.all([
      uploadPartnerBatch(JSON.parse(JSON.stringify(concurrentBatch))),
      uploadPartnerBatch(JSON.parse(JSON.stringify(concurrentBatch))),
    ]);
    const statuses = [r5a.data?.status, r5b.data?.status].sort();
    assert('两路都成功返回', r5a.success === true && r5b.success === true, undefined, { r5a, r5b });
    assert('恰为一个 accepted + 一个 duplicate', JSON.stringify(statuses) === JSON.stringify(['accepted', 'duplicate']),
      `实际 ${JSON.stringify(statuses)}`);
    assert('只写入 2 条服务记录', (await countServiceRecords(concurrentBatch.batch_no)) === 2);
    assert('只写入 2 条积分流水', (await countPointsLogs(concurrentBatch.batch_no)) === 2);
    const afterA5 = (await getVolunteer(volunteerAId)).total_points;
    const afterB5 = (await getVolunteer(volunteerBId)).total_points;
    const expectedA = before5 + Math.round(1 * 10 * 1.3 * 1.2); // education 1.3, rating 5
    assert('志愿者A 只加了一次积分', afterA5 === expectedA, `${afterA5} vs ${expectedA}`);
    assert('志愿者B 只加了一次积分', afterB5 === beforeB5 + Math.round(1 * 10 * 1.3 * 1.2),
      `${afterB5} vs ${beforeB5 + Math.round(1 * 10 * 1.3 * 1.2)}`);

    // -------------------------------------------------------------------------
    console.log('\n--- 用例5b: 先行者回滚时，等待方自动抢注成功 ---');
    const s5b = randomSuffix();
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      `INSERT INTO service_batches (batch_no, partner_id, status, item_count, content_hash)
       VALUES ($1, $2, 'accepted', 1, 'pending')`,
      [`BATCH-${s5b}`, 'partner-org-1']
    );

    const blockedBatch = makeBatch(s5b, [
      record('Q-1', volunteerAId, { service_type: 'environmental', duration_hours: 1 }),
    ]);
    const blockedPromise = uploadPartnerBatch(JSON.parse(JSON.stringify(blockedBatch)));
    await new Promise((r) => setTimeout(r, 500)); // 确保请求已堵在锁上

    await blocker.query('ROLLBACK'); // 模拟先行者整批校验失败
    blocker.release();

    const unblocked = await blockedPromise;
    assert('等待方最终成功 accepted', unblocked.success === true && unblocked.data?.status === 'accepted',
      undefined, unblocked);
    assert('等待方写入 1 条记录', (await countServiceRecords(blockedBatch.batch_no)) === 1);

    // -------------------------------------------------------------------------
    console.log('\n--- 用例6: 管理员按批次号查看 新增/已接收/冲突 结果 ---');
    const adminView = await getBatchByNo(batch1.batch_no);
    assert('管理员可查到批次', adminView.success === true, undefined, adminView);
    const b = adminView.data?.batch;
    assert('批次状态反映最近一次判定 duplicate', b?.status === 'duplicate', undefined, b);
    assert('新增数保留为 3', b?.accepted_count === 3, undefined, b);
    // 历史：首批(accepted) + 原样重试 + 三轮冲突试验 + 纠正后重发，全部可查
    const attempts = adminView.data?.attempts;
    assert('每次来件都有一组 attempt 明细', Array.isArray(attempts) && attempts.length >= 5,
      `实际 ${attempts?.length}`, attempts?.map((a: any) => ({ no: a.attempt_no, ...((({ accepted, duplicate, conflict }) => ({ accepted, duplicate, conflict }))(a)) })));
    const firstAttempt = attempts[0];
    assert('第 1 次来件为新增', firstAttempt.accepted === 3 && firstAttempt.duplicate === 0,
      undefined, firstAttempt);
    assert('跨历次来件累计视角包含新增', adminView.data?.totals.accepted === 3,
      undefined, adminView.data?.totals);
    assert('跨历次来件累计视角包含已接收', adminView.data?.totals.duplicate > 0,
      undefined, adminView.data?.totals);
    assert('跨历次来件累计视角包含冲突', adminView.data?.totals.conflict > 0,
      undefined, adminView.data?.totals);
    const conflictView = await getBatchByNo(batch1.batch_no);
    assert('可反复查询不改变数据', conflictView.data?.batch.accepted_count === 3);

    const list = await listBatches(1, 50);
    const batchNos: string[] = list.data?.batches.map((x: any) => x.batch_no);
    assert('批次列表包含已测批次', batchNos.includes(batch1.batch_no) && batchNos.includes(concurrentBatch.batch_no),
      undefined, batchNos);

    const conflictList = await listBatches(1, 50, 'conflict');
    assert('可按状态筛选批次（无残留 conflict 批次时为空数组）',
      Array.isArray(conflictList.data?.batches), undefined, conflictList.data);

    // -------------------------------------------------------------------------
    console.log('\n--- 用例7: 不同机构复用批次号 → 拒绝 ---');
    const foreign = { ...JSON.parse(JSON.stringify(batch1)), partner_id: 'partner-org-9' };
    const foreignResp = await uploadPartnerBatch(foreign);
    assert('跨机构批次号被拒绝', foreignResp.success === false && (foreignResp.error?.includes('其他合作机构') ?? false),
      undefined, foreignResp);

    // -------------------------------------------------------------------------
    console.log('\n--- 用例8: 爽约条目扣分且只扣一次 ---');
    const s8 = randomSuffix();
    const before8 = (await getVolunteer(volunteerAId)).total_points;
    const noShowBatch = makeBatch(s8, [
      record('N-1', volunteerAId, { is_no_show: true }),
    ]);
    const ns = await uploadPartnerBatch(noShowBatch);
    assert('爽约批次 accepted', ns.data?.status === 'accepted', undefined, ns.data);
    const after8 = (await getVolunteer(volunteerAId)).total_points;
    assert('爽约扣 20 分', after8 === Math.max(0, before8 - 20), `${after8} vs ${Math.max(0, before8 - 20)}`);
    const nsRetry = await uploadPartnerBatch(JSON.parse(JSON.stringify(noShowBatch)));
    assert('爽约批次重试 duplicate', nsRetry.data?.status === 'duplicate');
    const after8r = (await getVolunteer(volunteerAId)).total_points;
    assert('爽约重试不重复扣分', after8r === after8, `${after8r} vs ${after8}`);

    // -------------------------------------------------------------------------
    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = testResults.filter((r) => r.passed).length;
    const failed = testResults.filter((r) => !r.passed).length;
    console.log(`总计: ${testResults.length} 个用例`);
    console.log(`通过: ${passed} 个 ✓`);
    console.log(`失败: ${failed} 个 ✗`);

    if (failed > 0) {
      console.log('\n失败用例详情:');
      testResults.filter((r) => !r.passed).forEach((r) => {
        console.log(`  - ${r.name}: ${r.error}`);
      });
    }
    console.log('\n========================================\n');
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (error) {
    console.error('测试执行出错:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
    await pg.stop();
  }
};

runTests();
