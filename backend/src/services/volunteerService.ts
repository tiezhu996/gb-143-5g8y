import { Volunteer, ServiceRecord, PointsLog, ApiResponse, CreateServiceRecordResult } from '../types';
import pool from '../db/pool';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel, checkNewBadges } from './badgeService';
import { logCreditChange, isCreditLimited, CREDIT_LIMIT_THRESHOLD, recalculateCreditScore } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export const createServiceRecord = async (record: ServiceRecord): Promise<ApiResponse<CreateServiceRecordResult>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [record.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0] as Volunteer;

    if (isCreditLimited(volunteer.credit_score)) {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.volunteers.creditLimited,
        details: {
          credit_score: volunteer.credit_score,
          credit_limit_threshold: CREDIT_LIMIT_THRESHOLD,
          message: messages.volunteers.creditLimitedDetail(volunteer.credit_score, CREDIT_LIMIT_THRESHOLD)
        }
      };
    }

    const pointsEarned = record.is_no_show ? 0 : calculatePoints(
      record.duration_hours,
      record.service_type,
      record.rating
    );

    const insertResult = await client.query(
      `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show, location, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        record.volunteer_id,
        record.service_type,
        record.duration_hours,
        record.rating,
        pointsEarned,
        record.is_no_show || false,
        record.location,
        record.description,
      ]
    );

    const newRecord = insertResult.rows[0];

    let pointsChange = pointsEarned;
    if (record.is_no_show) {
      pointsChange = -calculateNoShowPenalty();
    }

    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, oldTotalPoints + pointsChange);
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
       SET total_points = $1,
           level = $2,
           service_count = service_count + $3
       WHERE id = $4`,
      [newTotalPoints, newLevel, record.is_no_show ? 0 : 1, volunteer.id]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        volunteer.id,
        pointsChange,
        record.is_no_show ? '爽约扣分' : `服务积分: ${record.service_type}`,
        oldTotalPoints,
        newTotalPoints,
        newRecord.id,
        'service_record',
      ]
    );

    let newBadges: any[] = [];
    if (newLevel > oldLevel) {
      const currentBadges = await client.query(
        'SELECT * FROM badges WHERE volunteer_id = $1',
        [volunteer.id]
      );
      newBadges = await checkNewBadges(volunteer.id, newLevel, currentBadges.rows);
    }

    await client.query('COMMIT');

    const creditResult = await recalculateCreditScore(volunteer.id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        volunteer.id,
        creditResult.changeAmount,
        record.is_no_show ? '服务爽约-信用分重算' : `完成服务-信用分重算: ${record.service_type}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        newRecord.id,
        'service_record'
      );
    }

    return {
      success: true,
      data: {
        record: newRecord,
        pointsChange,
        newTotalPoints,
        newLevel,
        newBadges,
        levelUp: newLevel > oldLevel,
        creditScore: creditResult ? creditResult.afterScore : volunteer.credit_score,
        creditChange: creditResult ? creditResult.changeAmount : 0,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.createServiceRecordFailed, error);
    return { success: false, error: messages.volunteers.serviceRecordCreateFailed };
  } finally {
    client.release();
  }
};

export const batchCreateServiceRecords = async (
  records: ServiceRecord[]
): Promise<ApiResponse<any>> => {
  const results: any[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const record of records) {
    const result = await createServiceRecord(record);
    if (result.success) {
      successCount++;
      results.push(result.data);
    } else {
      failCount++;
      results.push({ error: result.error, record });
    }
  }

  return {
    success: true,
    data: {
      total: records.length,
      successCount,
      failCount,
      results,
    },
  };
};

export const getVolunteerServiceRecords = async (
  volunteerId: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;

    const countResult = await client.query(
      'SELECT COUNT(*) as total FROM service_records WHERE volunteer_id = $1',
      [volunteerId]
    );

    const recordsResult = await client.query(
      `SELECT * FROM service_records
       WHERE volunteer_id = $1
       ORDER BY recorded_at DESC
       LIMIT $2 OFFSET $3`,
      [volunteerId, pageSize, offset]
    );

    return {
      success: true,
      data: {
        records: recordsResult.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

export const getServiceRecordById = async (
  recordId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT * FROM service_records WHERE id = $1',
      [recordId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};

export const deleteServiceRecord = async (
  recordId: string,
  adminId: string,
  reason: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1',
      [recordId]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = recordResult.rows[0] as ServiceRecord;

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [record.volunteer_id]
    );

    if (volunteerResult.rows.length > 0) {
      const volunteer = volunteerResult.rows[0] as Volunteer;
      const pointsToDeduct = record.points_earned || 0;
      const newTotalPoints = Math.max(0, volunteer.total_points - pointsToDeduct);
      const newLevel = calculateLevel(newTotalPoints);

      await client.query(
        `UPDATE volunteers
         SET total_points = $1, level = $2, service_count = GREATEST(0, service_count - 1)
         WHERE id = $3`,
        [newTotalPoints, newLevel, volunteer.id]
      );

      await client.query(
        `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [volunteer.id, -pointsToDeduct, `管理员删除记录: ${reason}`, volunteer.total_points, newTotalPoints, recordId, 'admin_delete']
      );
    }

    await client.query('DELETE FROM service_records WHERE id = $1', [recordId]);

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, 'delete', 'service_record', recordId, record, reason]
    );

    await client.query('COMMIT');

    const creditResult = await recalculateCreditScore(record.volunteer_id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        record.volunteer_id,
        creditResult.changeAmount,
        '删除服务记录-信用分重算',
        creditResult.beforeScore,
        creditResult.afterScore,
        recordId,
        'admin_delete'
      );
    }

    return {
      success: true,
      message: messages.volunteers.serviceRecordDeleted,
      data: creditResult ? {
        creditScore: creditResult.afterScore,
        creditChange: creditResult.changeAmount,
        creditBreakdown: creditResult.breakdown,
      } : undefined,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.deleteServiceRecordFailed, error);
    return { success: false, error: messages.volunteers.serviceRecordDeleteFailed };
  } finally {
    client.release();
  }
};
