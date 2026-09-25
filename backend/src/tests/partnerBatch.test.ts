import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { submitPartnerBatch, getPartnerBatchByNo } from '../services/partnerBatchService';
import { createVolunteer, getVolunteerById } from '../services/volunteerManager';
import { adjustCreditScore } from '../services/adminService';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({
    name,
    passed: condition,
    error: condition ? undefined : error,
    details,
  });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const countPointsLogs = async (volunteerId: string): Promise<number> => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT COUNT(*) as count FROM points_logs WHERE volunteer_id = $1',
      [volunteerId]
    );
    return parseInt(result.rows[0].count);
  } finally {
    client.release();
  }
};

const countServiceRecords = async (volunteerId: string): Promise<number> => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT COUNT(*) as count FROM service_records WHERE volunteer_id = $1',
      [volunteerId]
    );
    return parseInt(result.rows[0].count);
  } finally {
    client.release();
  }
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  志愿者积分与信用评估系统 - 验证用例');
  console.log('  测试场景: 合作机构批次上传幂等处理');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    console.log('\n--- 前置条件: 创建志愿者 ---');
    const v1Result = await createVolunteer('测试志愿者-机构批次甲', '13900000011', 'batch-a@example.com');
    const v2Result = await createVolunteer('测试志愿者-机构批次乙', '13900000012', 'batch-b@example.com');
    assert('志愿者创建成功', v1Result.success && v2Result.success, '志愿者创建失败', { v1Result, v2Result });
    const volunteerId1 = v1Result.data?.id;
    const volunteerId2 = v2Result.data?.id;
    if (!volunteerId1 || !volunteerId2) {
      console.log('\n⚠️  志愿者创建失败，无法继续测试');
      return;
    }

    const batchNo = `ORG-A-${Date.now()}`;
    const makeRecords = () => [
      {
        external_record_no: 'R-1001',
        volunteer_id: volunteerId1,
        service_type: 'elderly_care',
        duration_hours: 2,
        rating: 5,
        is_no_show: false,
        description: '老人陪护2小时',
      },
      {
        external_record_no: 'R-1002',
        volunteer_id: volunteerId2,
        service_type: 'education',
        duration_hours: 3,
        rating: 4,
        is_no_show: false,
        description: '教育辅导3小时',
      },
    ];

    console.log('\n--- 用例1: 首次提交批次，全部新增入账 ---');
    const firstResult = await submitPartnerBatch(batchNo, '某公益机构', makeRecords());
    assert('首次提交成功', firstResult.success === true, '首次提交应成功', firstResult);
    assert('批次状态为processed', firstResult.data?.status === 'processed',
      `期望processed，实际${firstResult.data?.status}`, firstResult.data);
    assert('新增2条记录', firstResult.data?.new_count === 2,
      `期望2条新增，实际${firstResult.data?.new_count}`, firstResult.data);
    assert('每条结果标记为new',
      firstResult.data?.results?.every((r: any) => r.status === 'new') === true,
      '所有条目应为new', firstResult.data?.results);

    const v1AfterFirst = await getVolunteerById(volunteerId1);
    const v2AfterFirst = await getVolunteerById(volunteerId2);
    // elderly_care 权重1.5: 2h*10*1.5*(1+0.2)=36; education 权重1.3: 3h*10*1.3*(1+0.1)=43
    assert('志愿者甲积分增加36分', v1AfterFirst.data?.total_points === 36,
      `期望36，实际${v1AfterFirst.data?.total_points}`, v1AfterFirst.data);
    assert('志愿者乙积分增加43分', v2AfterFirst.data?.total_points === 43,
      `期望43，实际${v2AfterFirst.data?.total_points}`, v2AfterFirst.data);
    const logsAfterFirst1 = await countPointsLogs(volunteerId1);
    const logsAfterFirst2 = await countPointsLogs(volunteerId2);
    assert('志愿者甲有1条积分流水', logsAfterFirst1 === 1, `期望1条，实际${logsAfterFirst1}`);
    assert('志愿者乙有1条积分流水', logsAfterFirst2 === 1, `期望1条，实际${logsAfterFirst2}`);

    console.log('\n--- 用例2: 相同内容重试，回复已接收，累计不变 ---');
    const retryResult = await submitPartnerBatch(batchNo, '某公益机构', makeRecords());
    assert('重试提交返回成功', retryResult.success === true, '相同内容重试应返回已接收', retryResult);
    assert('批次状态为duplicate', retryResult.data?.status === 'duplicate',
      `期望duplicate，实际${retryResult.data?.status}`, retryResult.data);
    assert('返回已接收提示', retryResult.message === '批次已接收，内容一致，未重复入账',
      `实际消息: ${retryResult.message}`, retryResult);
    assert('每条结果标记为duplicate',
      retryResult.data?.results?.every((r: any) => r.status === 'duplicate') === true,
      '所有条目应为duplicate', retryResult.data?.results);

    const v1AfterRetry = await getVolunteerById(volunteerId1);
    const v2AfterRetry = await getVolunteerById(volunteerId2);
    assert('志愿者甲积分不变', v1AfterRetry.data?.total_points === 36,
      `期望36，实际${v1AfterRetry.data?.total_points}`);
    assert('志愿者乙积分不变', v2AfterRetry.data?.total_points === 43,
      `期望43，实际${v2AfterRetry.data?.total_points}`);
    assert('志愿者甲服务次数不变', v1AfterRetry.data?.service_count === 1,
      `期望1，实际${v1AfterRetry.data?.service_count}`);
    assert('积分流水未新增', (await countPointsLogs(volunteerId1)) === 1, '流水应仍为1条');
    assert('服务记录未新增', (await countServiceRecords(volunteerId1)) === 1, '记录应仍为1条');

    console.log('\n--- 用例3: 同号修改时长/类型/评分，整批拒绝并指出冲突 ---');
    const tampered = makeRecords();
    tampered[0].duration_hours = 5;
    tampered[1].rating = 2;
    const conflictResult = await submitPartnerBatch(batchNo, '某公益机构', tampered);
    assert('冲突提交被拒绝', conflictResult.success === false, '内容不一致应拒绝', conflictResult);
    assert('返回冲突状态', conflictResult.details?.status === 'conflicted',
      `期望conflicted，实际${conflictResult.details?.status}`, conflictResult.details);
    assert('指出2条冲突条目', conflictResult.details?.conflict_count === 2,
      `期望2条冲突，实际${conflictResult.details?.conflict_count}`, conflictResult.details);
    const conflict1 = conflictResult.details?.conflicts?.find((c: any) => c.external_record_no === 'R-1001');
    const conflict2 = conflictResult.details?.conflicts?.find((c: any) => c.external_record_no === 'R-1002');
    assert('R-1001冲突字段为时长', conflict1?.diff_fields?.includes('duration_hours') === true,
      'R-1001应指出duration_hours差异', conflict1);
    assert('R-1002冲突字段为评分', conflict2?.diff_fields?.includes('rating') === true,
      'R-1002应指出rating差异', conflict2);
    assert('冲突条目含既有内容', conflict1?.existing?.duration_hours === 2,
      '应返回已存时长2小时', conflict1);
    assert('冲突条目含提交内容', conflict1?.incoming?.duration_hours === 5,
      '应返回提交时长5小时', conflict1);

    const v1AfterConflict = await getVolunteerById(volunteerId1);
    assert('冲突后积分保持不变', v1AfterConflict.data?.total_points === 36,
      `期望36，实际${v1AfterConflict.data?.total_points}`);
    assert('冲突后积分流水未新增', (await countPointsLogs(volunteerId1)) === 1, '流水应仍为1条');
    assert('冲突后服务记录未新增', (await countServiceRecords(volunteerId1)) === 1, '记录应仍为1条');

    console.log('\n--- 用例4: 含无效条目的批次，一条也不写 ---');
    const invalidBatchNo = `ORG-A-INVALID-${Date.now()}`;
    const invalidRecords = [
      {
        external_record_no: 'R-2001',
        volunteer_id: volunteerId1,
        service_type: 'community_service',
        duration_hours: 1,
        rating: 5,
        is_no_show: false,
      },
      {
        external_record_no: 'R-2002',
        volunteer_id: '00000000-0000-0000-0000-000000000000',
        service_type: 'community_service',
        duration_hours: 1,
        rating: 5,
        is_no_show: false,
      },
    ];
    const invalidResult = await submitPartnerBatch(invalidBatchNo, '某公益机构', invalidRecords);
    assert('无效批次被拒绝', invalidResult.success === false, '含无效条目应整批拒绝', invalidResult);
    assert('指出无效条目R-2002',
      invalidResult.details?.invalid_records?.some((r: any) => r.external_record_no === 'R-2002') === true,
      '应指出R-2002无效', invalidResult.details);
    assert('有效条目也未入账', (await countServiceRecords(volunteerId1)) === 1,
      'R-2001不应写入，记录仍应为1条');
    assert('有效条目积分未增加', (await getVolunteerById(volunteerId1)).data?.total_points === 36,
      '积分应仍为36');

    console.log('\n--- 用例5: 批内重复机构记录号，整批拒绝 ---');
    const dupBatchNo = `ORG-A-DUP-${Date.now()}`;
    const dupRecords = [
      { external_record_no: 'R-3001', volunteer_id: volunteerId1, service_type: 'other', duration_hours: 1, rating: 5, is_no_show: false },
      { external_record_no: 'R-3001', volunteer_id: volunteerId1, service_type: 'other', duration_hours: 2, rating: 5, is_no_show: false },
    ];
    const dupResult = await submitPartnerBatch(dupBatchNo, '某公益机构', dupRecords);
    assert('批内重复被拒绝', dupResult.success === false, '批内重复号应拒绝', dupResult);
    assert('指出重复记录号', dupResult.details?.duplicate_record_nos?.includes('R-3001') === true,
      '应指出R-3001重复', dupResult.details);
    assert('批内重复批次一条未写', (await countServiceRecords(volunteerId1)) === 1, '记录应仍为1条');

    console.log('\n--- 用例6: 两路并发提交同一批次，只留一份记录和一套积分流水 ---');
    const concurrentBatchNo = `ORG-A-CONCURRENT-${Date.now()}`;
    const makeConcurrentRecords = () => [
      {
        external_record_no: 'R-4001',
        volunteer_id: volunteerId1,
        service_type: 'medical_assist',
        duration_hours: 1,
        rating: 5,
        is_no_show: false,
      },
    ];
    const [resultA, resultB] = await Promise.all([
      submitPartnerBatch(concurrentBatchNo, '某公益机构', makeConcurrentRecords()),
      submitPartnerBatch(concurrentBatchNo, '某公益机构', makeConcurrentRecords()),
    ]);
    const statuses = [resultA.data?.status, resultB.data?.status].sort();
    assert('两路请求均返回成功', resultA.success === true && resultB.success === true,
      '并发提交都应成功响应', { a: resultA, b: resultB });
    assert('一路新增一路已接收',
      statuses[0] === 'duplicate' && statuses[1] === 'processed',
      `期望一processed一duplicate，实际${JSON.stringify(statuses)}`, statuses);
    // medical_assist 权重1.6: 1h*10*1.6*(1+0.2)=19，只入账一次
    const v1AfterConcurrent = await getVolunteerById(volunteerId1);
    assert('积分只入账一次', v1AfterConcurrent.data?.total_points === 36 + 19,
      `期望55，实际${v1AfterConcurrent.data?.total_points}`, v1AfterConcurrent.data);
    assert('服务记录只留一份', (await countServiceRecords(volunteerId1)) === 2,
      '志愿者甲应共2条记录（用例1一条+并发一条）');
    assert('积分流水只有一套', (await countPointsLogs(volunteerId1)) === 2,
      '志愿者甲应共2条流水（用例1一条+并发一条）');

    console.log('\n--- 用例7: 管理员按批次号查看新增/已接收/冲突结果 ---');
    const batchView = await getPartnerBatchByNo(batchNo);
    assert('批次查询成功', batchView.success === true, '批次应可查', batchView);
    assert('批次状态为conflicted', batchView.data?.batch?.status === 'conflicted',
      `期望conflicted，实际${batchView.data?.batch?.status}`, batchView.data?.batch);
    assert('可查新增条目2条', batchView.data?.records?.length === 2,
      `期望2条新增记录，实际${batchView.data?.records?.length}`, batchView.data?.records);
    assert('新增条目关联服务记录',
      batchView.data?.records?.every((r: any) => !!r.service_record_id) === true,
      '新增条目应关联service_record_id', batchView.data?.records);
    assert('可查冲突条目2条', batchView.data?.conflicts?.length === 2,
      `期望2条冲突，实际${batchView.data?.conflicts?.length}`, batchView.data?.conflicts);
    assert('批次累计重复提交次数', batchView.data?.batch?.duplicate_count >= 2,
      '用例2的2条已接收应计入duplicate_count', batchView.data?.batch);

    const concurrentView = await getPartnerBatchByNo(concurrentBatchNo);
    assert('并发批次状态为processed', concurrentView.data?.batch?.status === 'processed',
      `期望processed，实际${concurrentView.data?.batch?.status}`, concurrentView.data?.batch);
    assert('并发批次只入账1条', concurrentView.data?.batch?.new_count === 1,
      `期望1条新增，实际${concurrentView.data?.batch?.new_count}`, concurrentView.data?.batch);

    const notFoundView = await getPartnerBatchByNo('ORG-A-NOT-EXIST');
    assert('不存在批次返回未找到', notFoundView.success === false && notFoundView.error === '批次不存在',
      '应返回批次不存在', notFoundView);

    console.log('\n--- 用例8: 低信用志愿者条目整批拒绝 ---');
    await adjustCreditScore(volunteerId2, -100, 'test-admin', '测试用例: 压低信用分');
    const lowCreditBatchNo = `ORG-A-LOWCREDIT-${Date.now()}`;
    const lowCreditRecords = [
      { external_record_no: 'R-5001', volunteer_id: volunteerId1, service_type: 'other', duration_hours: 1, rating: 5, is_no_show: false },
      { external_record_no: 'R-5002', volunteer_id: volunteerId2, service_type: 'other', duration_hours: 1, rating: 5, is_no_show: false },
    ];
    const lowCreditResult = await submitPartnerBatch(lowCreditBatchNo, '某公益机构', lowCreditRecords);
    assert('低信用批次被拒绝', lowCreditResult.success === false, '信用受限条目应整批拒绝', lowCreditResult);
    assert('指出信用受限条目R-5002',
      lowCreditResult.details?.invalid_records?.some((r: any) => r.external_record_no === 'R-5002') === true,
      '应指出R-5002信用受限', lowCreditResult.details);
    assert('低信用批次一条未写', (await countServiceRecords(volunteerId1)) === 2,
      '志愿者甲记录应仍为2条');
    await adjustCreditScore(volunteerId2, 100, 'test-admin', '测试用例: 恢复信用分');

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
        console.log(`  - ${r.name}`);
        if (r.error) console.log(`    原因: ${r.error}`);
      });
    }

    console.log('\n========================================\n');
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('测试执行出错:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runTests();
