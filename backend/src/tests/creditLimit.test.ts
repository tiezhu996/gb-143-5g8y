import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createServiceRecord } from '../services/volunteerService';
import { createVolunteer, getVolunteerById } from '../services/volunteerManager';
import { adjustCreditScore } from '../services/adminService';
import { isCreditLimited, CREDIT_LIMIT_THRESHOLD } from '../services/creditService';

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

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  志愿者积分与信用评估系统 - 验证用例');
  console.log('  测试场景: 低信用不可接单');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    console.log('\n--- 前置条件: 创建志愿者 ---');
    const volunteerResult = await createVolunteer('测试志愿者-低信用', '13900000001', 'test@example.com');
    assert('志愿者创建成功', volunteerResult.success && !!volunteerResult.data, '志愿者创建失败', volunteerResult);
    const volunteerId = volunteerResult.data?.id;
    assert('志愿者ID获取成功', !!volunteerId, '志愿者ID为空', { volunteerId });

    if (!volunteerId) {
      console.log('\n⚠️  志愿者创建失败，无法继续测试');
      return;
    }

    console.log('\n--- 用例1: 验证信用限制阈值 ---');
    assert('信用限制阈值为30分', CREDIT_LIMIT_THRESHOLD === 30, `期望30，实际${CREDIT_LIMIT_THRESHOLD}`);
    assert('isCreditLimited(29)返回true', isCreditLimited(29) === true, '29分应被限制');
    assert('isCreditLimited(30)返回false', isCreditLimited(30) === false, '30分不应被限制');
    assert('isCreditLimited(50)返回false', isCreditLimited(50) === false, '50分不应被限制');
    assert('isCreditLimited(0)返回true', isCreditLimited(0) === true, '0分应被限制');

    console.log('\n--- 用例2: 调整信用分到限制线以下 ---');
    const creditAdjustResult = await adjustCreditScore(
      volunteerId,
      -80,
      'test-admin',
      '测试用例: 将信用分调整到限制线以下'
    );
    assert('信用分调整成功', creditAdjustResult.success, '信用分调整失败', creditAdjustResult);
    assert('调整后信用分为20分', creditAdjustResult.data?.newCreditScore === 20,
      `期望20分，实际${creditAdjustResult.data?.newCreditScore}分`, creditAdjustResult.data);

    const volunteerAfterAdjust = await getVolunteerById(volunteerId);
    assert('数据库中信用分已更新为20分', volunteerAfterAdjust.data?.credit_score === 20,
      `期望20分，实际${volunteerAfterAdjust.data?.credit_score}分`, volunteerAfterAdjust.data);

    console.log('\n--- 用例3: 低信用志愿者尝试创建服务记录（应被拒绝） ---');
    const serviceRecord = {
      volunteer_id: volunteerId,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
      description: '低信用测试用例',
    };

    const createResult = await createServiceRecord(serviceRecord);
    assert('创建服务记录被拒绝', createResult.success === false, '低信用应被拒绝创建记录', createResult);
    assert('返回明确错误信息', createResult.error === '信用分过低，无法接单',
      `期望错误信息为"信用分过低，无法接单"，实际为"${createResult.error}"`, createResult);
    assert('返回当前信用分', createResult.details?.credit_score === 20,
      `期望返回信用分20，实际返回${createResult.details?.credit_score}`, createResult.details);
    assert('返回限制阈值', createResult.details?.credit_limit_threshold === 30,
      `期望返回阈值30，实际返回${createResult.details?.credit_limit_threshold}`, createResult.details);
    assert('返回提示信息', !!createResult.details?.message,
      '应返回提示信息', createResult.details);

    console.log('\n--- 用例4: 验证服务记录未被创建 ---');
    const volunteerAfterAttempt = await getVolunteerById(volunteerId);
    assert('积分未增加', volunteerAfterAttempt.data?.total_points === 0,
      `期望积分0，实际${volunteerAfterAttempt.data?.total_points}`, volunteerAfterAttempt.data);
    assert('服务次数未增加', volunteerAfterAttempt.data?.service_count === 0,
      `期望服务次数0，实际${volunteerAfterAttempt.data?.service_count}`, volunteerAfterAttempt.data);

    console.log('\n--- 用例5: 恢复信用分后可正常创建记录 ---');
    const creditRestoreResult = await adjustCreditScore(
      volunteerId,
      80,
      'test-admin',
      '测试用例: 恢复信用分'
    );
    assert('信用分恢复成功', creditRestoreResult.success);
    assert('恢复后信用分为100分', creditRestoreResult.data?.newCreditScore === 100,
      `期望100分，实际${creditRestoreResult.data?.newCreditScore}分`, creditRestoreResult.data);

    const normalRecordResult = await createServiceRecord({
      volunteer_id: volunteerId,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
      description: '正常信用测试用例',
    });
    assert('正常信用可创建服务记录', normalRecordResult.success === true, '正常信用应能创建记录', normalRecordResult);
    assert('服务积分正确计算', (normalRecordResult.data?.pointsChange ?? 0) > 0, '积分应大于0', normalRecordResult.data);

    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = testResults.filter(r => r.passed).length;
    const failed = testResults.filter(r => !r.passed).length;
    console.log(`总计: ${testResults.length} 个用例`);
    console.log(`通过: ${passed} 个 ✓`);
    console.log(`失败: ${failed} 个 ✗`);

    if (failed > 0) {
      console.log('\n失败用例详情:');
      testResults.filter(r => !r.passed).forEach(r => {
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
