import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createServiceRecord } from '../services/volunteerService';
import { createVolunteer, getVolunteerById, getVolunteerSummary } from '../services/volunteerManager';
import { createComplaint, handleComplaint } from '../services/complaintService';
import { recalculateCreditScore, CREDIT_LIMIT_THRESHOLD } from '../services/creditService';

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
  console.log('  信用分计算集成验证用例');
  console.log('  测试: 服务次数、评分、爽约、投诉影响信用分');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    console.log('\n--- 前置条件: 创建测试志愿者 ---');
    const volunteerResult = await createVolunteer('信用分测试-综合', '13900000002', 'credit-test@example.com');
    assert('志愿者创建成功', volunteerResult.success && !!volunteerResult.data, '志愿者创建失败', volunteerResult);
    const volunteerId = volunteerResult.data?.id;
    assert('志愿者ID获取成功', !!volunteerId, '志愿者ID为空', { volunteerId });

    if (!volunteerId) {
      console.log('\n⚠️  志愿者创建失败，无法继续测试');
      return;
    }

    const initialVolunteer = await getVolunteerById(volunteerId);
    assert('初始信用分为100分', initialVolunteer.data?.credit_score === 100,
      `期望100分，实际${initialVolunteer.data?.credit_score}分`, initialVolunteer.data);

    console.log('\n========================================');
    console.log('  场景1: 服务次数影响信用分');
    console.log('========================================');

    console.log('\n--- 用例1.1: 完成服务后服务次数增加 ---');
    const service1 = await createServiceRecord({
      volunteer_id: volunteerId,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 5,
      description: '信用分测试-服务1',
    });
    assert('服务记录创建成功', service1.success === true, '服务记录创建失败', service1);

    const volunteerAfter1 = await getVolunteerById(volunteerId);
    assert('服务次数变为1', volunteerAfter1.data?.service_count === 1,
      `期望1次，实际${volunteerAfter1.data?.service_count}次`, volunteerAfter1.data);

    console.log('\n--- 用例1.2: 信用分因服务次数增加 ---');
    const creditAfter1 = volunteerAfter1.data?.credit_score || 0;
    assert('信用分增加(100 -> 100.5取整)', creditAfter1 >= 100,
      `信用分应≥100，实际${creditAfter1}`, { credit_score: creditAfter1 });

    console.log('\n--- 用例1.3: 继续增加服务次数验证上限 ---');
    for (let i = 0; i < 45; i++) {
      await createServiceRecord({
        volunteer_id: volunteerId,
        service_type: 'community_service',
        duration_hours: 1,
        rating: 3,
        description: `信用分测试-批量服务${i}`,
      });
    }

    const volunteerAfterMany = await getVolunteerById(volunteerId);
    assert('服务次数达到46次', volunteerAfterMany.data?.service_count === 46,
      `期望46次，实际${volunteerAfterMany.data?.service_count}次`, volunteerAfterMany.data);

    console.log('\n========================================');
    console.log('  场景2: 评分影响信用分');
    console.log('========================================');

    console.log('\n--- 用例2.1: 高评分服务增加信用分 ---');
    const highRatingService = await createServiceRecord({
      volunteer_id: volunteerId,
      service_type: 'medical_assist',
      duration_hours: 3,
      rating: 5,
      description: '信用分测试-高评分',
    });
    assert('高评分服务创建成功', highRatingService.success === true, '高评分服务创建失败', highRatingService);

    const highRatingCredit = highRatingService.data?.creditScore;
    const highRatingChange = highRatingService.data?.creditChange;
    assert('返回信用分明细', !!highRatingCredit, '应返回信用分', highRatingService.data);
    assert('返回信用分变化', highRatingChange !== undefined, '应返回信用分变化', highRatingService.data);
    assert('返回信用分计算分解', !!highRatingService.data?.creditBreakdown,
      '应返回信用分计算分解', highRatingService.data?.creditBreakdown);

    console.log('\n--- 用例2.2: 低评分服务降低信用分 ---');
    const lowRatingService = await createServiceRecord({
      volunteer_id: volunteerId,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 1,
      description: '信用分测试-低评分',
    });
    assert('低评分服务创建成功', lowRatingService.success === true, '低评分服务创建失败', lowRatingService);

    const lowRatingCredit = lowRatingService.data?.creditScore;
    const lowRatingChange = lowRatingService.data?.creditChange ?? 0;
    assert('低评分服务信用分降低', lowRatingChange < 0,
      `低评分应降低信用分，变化量: ${lowRatingChange}`, { credit_change: lowRatingChange });

    console.log('\n========================================');
    console.log('  场景3: 爽约影响信用分');
    console.log('========================================');

    const noShowVolunteerResult = await createVolunteer('信用分测试-爽约', '13900000003', 'noshow-test@example.com');
    const noShowVolunteerId = noShowVolunteerResult.data?.id;

    if (noShowVolunteerId) {
      console.log('\n--- 用例3.1: 爽约服务信用分降低 ---');
      const noShowService = await createServiceRecord({
        volunteer_id: noShowVolunteerId,
        service_type: 'community_service',
        duration_hours: 2,
        rating: 3,
        is_no_show: true,
        description: '信用分测试-爽约',
      });
      assert('爽约服务记录创建成功', noShowService.success === true, '爽约服务创建失败', noShowService);

      const noShowCredit = noShowService.data?.creditScore;
      const noShowChange = noShowService.data?.creditChange ?? 0;
      assert('爽约后信用分降低', noShowChange < 0,
        `爽约应降低信用分，变化量: ${noShowChange}`, { credit_change: noShowChange });

      const noShowVolunteer = await getVolunteerById(noShowVolunteerId);
      const noShowCreditScore = noShowVolunteer.data?.credit_score ?? 100;
      assert('爽约后信用分低于100', noShowCreditScore < 100,
        `期望<100分，实际${noShowCreditScore}分`, noShowVolunteer.data);

      console.log('\n--- 用例3.2: 验证信用分计算分解包含爽约惩罚 ---');
      const breakdown = noShowService.data?.creditBreakdown;
      const noShowPenalty = breakdown?.noShowPenalty ?? 0;
      assert('分解中包含爽约惩罚', noShowPenalty < 0,
        `分解中应包含爽约惩罚，实际: ${noShowPenalty}`, breakdown);
      assert('分解中爽约次数为1', breakdown?.details?.noShowCount === 1,
        `分解中爽约次数应为1，实际: ${breakdown?.details?.noShowCount}`, breakdown?.details);
    }

    console.log('\n========================================');
    console.log('  场景4: 投诉影响信用分');
    console.log('========================================');

    const complaintVolunteerResult = await createVolunteer('信用分测试-投诉', '13900000004', 'complaint-test@example.com');
    const complaintVolunteerId = complaintVolunteerResult.data?.id;

    if (complaintVolunteerId) {
      console.log('\n--- 用例4.1: 创建投诉后信用分降低 ---');
      const complaint1 = await createComplaint(
        complaintVolunteerId,
        'poor_attitude',
        '服务态度不好，测试用例',
        undefined
      );
      assert('投诉创建成功', complaint1.success === true, '投诉创建失败', complaint1);

      const complaintCredit = complaint1.data?.creditScore;
      const complaintChange = complaint1.data?.creditChange ?? 0;
      assert('投诉后信用分降低', complaintChange < 0,
        `投诉应降低信用分，变化量: ${complaintChange}`, { credit_change: complaintChange });

      const volunteerAfterComplaint = await getVolunteerById(complaintVolunteerId);
      const complaintCreditScore = volunteerAfterComplaint.data?.credit_score ?? 100;
      assert('投诉后信用分降低', complaintCreditScore < 100,
        `期望<100分，实际${complaintCreditScore}分`, volunteerAfterComplaint.data);

      console.log('\n--- 用例4.2: 验证信用分计算分解包含投诉惩罚 ---');
      const complaintBreakdown = complaint1.data?.creditBreakdown;
      const complaintPenalty = complaintBreakdown?.complaintPenalty ?? 0;
      assert('分解中包含投诉惩罚', complaintPenalty < 0,
        `分解中应包含投诉惩罚，实际: ${complaintPenalty}`, complaintBreakdown);
      assert('分解中活跃投诉数为1', complaintBreakdown?.details?.activeComplaintCount === 1,
        `分解中活跃投诉数应为1，实际: ${complaintBreakdown?.details?.activeComplaintCount}`, complaintBreakdown?.details);

      console.log('\n--- 用例4.3: 处理投诉(驳回)后信用分恢复 ---');
      const handleReject = await handleComplaint(
        complaint1.data?.id!,
        'reject',
        'test-admin',
        '投诉不成立，测试驳回'
      );
      assert('投诉驳回成功', handleReject.success === true, '投诉驳回失败', handleReject);

      const rejectCredit = handleReject.data?.creditScore;
      const rejectChange = handleReject.data?.creditChange;
      assert('驳回后信用分增加', rejectChange > 0,
        `驳回投诉应增加信用分，变化量: ${rejectChange}`, { credit_change: rejectChange });

      console.log('\n--- 用例4.4: 创建新投诉并处理(支持) ---');
      const complaint2 = await createComplaint(
        complaintVolunteerId,
        'no_show',
        '爽约投诉，测试用例',
        undefined
      );
      assert('第二个投诉创建成功', complaint2.success === true, '第二个投诉创建失败', complaint2);

      const handleResolve = await handleComplaint(
        complaint2.data?.id!,
        'resolve',
        'test-admin',
        '投诉成立，扣除积分和信用分',
        1
      );
      assert('投诉处理成功', handleResolve.success === true, '投诉处理失败', handleResolve);
      assert('返回积分扣除', handleResolve.data?.pointsPenalty > 0,
        `应返回积分扣除，实际: ${handleResolve.data?.pointsPenalty}`, handleResolve.data);
      assert('返回信用分变化', handleResolve.data?.creditChange !== undefined,
        '应返回信用分变化', handleResolve.data);

      const volunteerAfterResolve = await getVolunteerById(complaintVolunteerId);
      const resolveCreditScore = volunteerAfterResolve.data?.credit_score ?? 100;
      assert('处理后信用分低于创建投诉前', resolveCreditScore < 100,
        `期望<100分，实际${resolveCreditScore}分`, volunteerAfterResolve.data);
    }

    console.log('\n========================================');
    console.log('  场景5: 信用分汇总接口验证');
    console.log('========================================');

    console.log('\n--- 用例5.1: 志愿者汇总接口返回信用分 ---');
    const summary = await getVolunteerSummary(volunteerId);
    assert('汇总接口成功', summary.success === true, '汇总接口失败', summary);
    assert('汇总包含志愿者信息', !!summary.data?.volunteer, '应包含志愿者信息', summary.data?.volunteer);
    assert('汇总包含信用分', summary.data?.volunteer?.credit_score !== undefined,
      '应包含信用分', { credit_score: summary.data?.volunteer?.credit_score });

    console.log('\n--- 用例5.2: 手动触发信用分重算 ---');
    const recalcResult = await recalculateCreditScore(volunteerId);
    assert('信用分重算成功', recalcResult !== null, '信用分重算失败', recalcResult);
    assert('返回重算前后分数', recalcResult?.beforeScore !== undefined && recalcResult?.afterScore !== undefined,
      '应返回重算前后分数', recalcResult);
    assert('返回计算分解', !!recalcResult?.breakdown, '应返回计算分解', recalcResult?.breakdown);

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
