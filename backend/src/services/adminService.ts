import { ApiResponse } from '../types';
import pool from '../db/pool';
import { calculateLevel, checkNewBadges } from './badgeService';
import { logCreditChange } from './creditService';
import { isCreditLimited } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export const adjustPoints = async (
  volunteerId: string,
  pointsChange: number,
  adminId: string,
  reason: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [volunteerId]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0];

    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, oldTotalPoints + pointsChange);
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
       SET total_points = $1, level = $2
       WHERE id = $3`,
      [newTotalPoints, newLevel, volunteerId]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [volunteerId, pointsChange, `管理员调整: ${reason}`, oldTotalPoints, newTotalPoints, 'admin_adjust']
    );

    let newBadges: any[] = [];
    let levelUp = false;
    if (newLevel > oldLevel) {
      const currentBadges = await client.query(
        'SELECT * FROM badges WHERE volunteer_id = $1',
        [volunteerId]
      );
      newBadges = await checkNewBadges(volunteerId, newLevel, currentBadges.rows);
      levelUp = true;
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [adminId, 'adjust_points', 'volunteer', volunteerId,
       { total_points: oldTotalPoints, level: oldLevel },
       { total_points: newTotalPoints, level: newLevel },
       reason]
    );

    await client.query('COMMIT');

    return {
      success: true,
      data: {
        pointsChange,
        oldTotalPoints,
        newTotalPoints,
        oldLevel,
        newLevel,
        levelUp,
        newBadges,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.adjustPointsFailed, error);
    return { success: false, error: messages.admin.adjustPointsFailed };
  } finally {
    client.release();
  }
};

export const adjustCreditScore = async (
  volunteerId: string,
  creditChange: number,
  adminId: string,
  reason: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [volunteerId]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0];

    const oldCreditScore = volunteer.credit_score;
    const newCreditScore = Math.max(0, Math.min(100, oldCreditScore + creditChange));

    await client.query(
      'UPDATE volunteers SET credit_score = $1 WHERE id = $2',
      [newCreditScore, volunteerId]
    );

    await logCreditChange(
      volunteerId,
      creditChange,
      `管理员调整: ${reason}`,
      oldCreditScore,
      newCreditScore,
      undefined,
      'admin_adjust'
    );

    const isLimited = isCreditLimited(newCreditScore);

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [adminId, 'adjust_credit', 'volunteer', volunteerId,
       { credit_score: oldCreditScore },
       { credit_score: newCreditScore, is_limited: isLimited },
       reason]
    );

    await client.query('COMMIT');

    return {
      success: true,
      data: {
        creditChange,
        oldCreditScore,
        newCreditScore,
        isLimited,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.adjustCreditFailed, error);
    return { success: false, error: messages.admin.adjustCreditFailed };
  } finally {
    client.release();
  }
};

export const getAdminAuditLogs = async (
  page: number = 1,
  pageSize: number = 20,
  adminId?: string,
  action?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    let query = 'SELECT * FROM admin_audit_logs WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM admin_audit_logs WHERE 1=1';
    const params: any[] = [];
    const countParams: any[] = [];
    let paramIndex = 1;

    if (adminId) {
      query += ` AND admin_id = $${paramIndex}`;
      countQuery += ` AND admin_id = $${paramIndex}`;
      params.push(adminId);
      countParams.push(adminId);
      paramIndex++;
    }

    if (action) {
      query += ` AND action = $${paramIndex}`;
      countQuery += ` AND action = $${paramIndex}`;
      params.push(action);
      countParams.push(action);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const countResult = await client.query(countQuery, countParams);

    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(pageSize, offset);

    const result = await client.query(query, params);

    return {
      success: true,
      data: {
        logs: result.rows,
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

export const setVolunteerStatus = async (
  volunteerId: string,
  isActive: boolean,
  adminId: string,
  reason: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [volunteerId]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const oldVolunteer = volunteerResult.rows[0];

    await client.query(
      'UPDATE volunteers SET is_active = $1 WHERE id = $2',
      [isActive, volunteerId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [adminId, isActive ? 'activate' : 'deactivate', 'volunteer', volunteerId,
       { is_active: oldVolunteer.is_active },
       { is_active: isActive },
       reason]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: messages.admin.statusChanged(isActive),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.setVolunteerStatusFailed, error);
    return { success: false, error: messages.admin.operationFailed };
  } finally {
    client.release();
  }
};
