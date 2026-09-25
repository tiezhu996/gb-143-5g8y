import crypto from 'crypto';
import { PoolClient } from 'pg';
import {
  ApiResponse,
  PartnerBatchRecord,
  PartnerRecordConflict,
  PartnerRecordResult,
  PartnerRecordSnapshot,
  PartnerServiceRecord,
  Volunteer,
} from '../types';
import pool from '../db/pool';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel } from './badgeService';
import { BADGE_NAMES, BADGE_DESCRIPTIONS } from '../types';
import { isCreditLimited, recalculateCreditScore, logCreditChange } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

const normalizeDuration = (value: number | string): string => {
  return Number(value).toFixed(2);
};

export const hashPartnerRecord = (record: PartnerBatchRecord): string => {
  const parts = [
    String(record.volunteer_id).toLowerCase(),
    record.service_type,
    normalizeDuration(record.duration_hours),
    String(record.rating),
    String(record.is_no_show || false),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
};

const snapshotOf = (record: PartnerBatchRecord): PartnerRecordSnapshot => ({
  volunteer_id: record.volunteer_id,
  service_type: record.service_type,
  duration_hours: Number(record.duration_hours),
  rating: record.rating,
  is_no_show: record.is_no_show || false,
});

const snapshotOfStored = (stored: PartnerServiceRecord): PartnerRecordSnapshot => ({
  volunteer_id: stored.volunteer_id,
  service_type: stored.service_type,
  duration_hours: Number(stored.duration_hours),
  rating: stored.rating,
  is_no_show: stored.is_no_show,
});

const diffFields = (
  stored: PartnerRecordSnapshot,
  incoming: PartnerRecordSnapshot
): string[] => {
  const fields: Array<keyof PartnerRecordSnapshot> = [
    'volunteer_id',
    'service_type',
    'duration_hours',
    'rating',
    'is_no_show',
  ];
  return fields.filter((field) => {
    const left = field === 'duration_hours' ? normalizeDuration(stored[field]) : stored[field];
    const right = field === 'duration_hours' ? normalizeDuration(incoming[field]) : incoming[field];
    return left !== right;
  });
};

const findDuplicateRecordNos = (records: PartnerBatchRecord[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const record of records) {
    if (seen.has(record.external_record_no)) {
      duplicates.add(record.external_record_no);
    }
    seen.add(record.external_record_no);
  }
  return Array.from(duplicates);
};

const insertBadgeIfMissing = async (
  client: PoolClient,
  volunteerId: string,
  starLevel: number
): Promise<void> => {
  await client.query(
    `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (volunteer_id, star_level) DO NOTHING`,
    [volunteerId, starLevel, BADGE_NAMES[starLevel], BADGE_DESCRIPTIONS[starLevel]]
  );
};

const applyServiceRecord = async (
  client: PoolClient,
  record: PartnerBatchRecord
): Promise<{ serviceRecordId: string; pointsChange: number }> => {
  const volunteerResult = await client.query(
    'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
    [record.volunteer_id]
  );
  const volunteer = volunteerResult.rows[0] as Volunteer;

  const pointsEarned = record.is_no_show
    ? 0
    : calculatePoints(record.duration_hours, record.service_type, record.rating);
  const pointsChange = record.is_no_show ? -calculateNoShowPenalty() : pointsEarned;

  const insertResult = await client.query(
    `INSERT INTO service_records
     (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show, location, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
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
  const serviceRecordId = insertResult.rows[0].id as string;

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
      serviceRecordId,
      'service_record',
    ]
  );

  if (newLevel > oldLevel) {
    for (let level = oldLevel + 1; level <= newLevel; level++) {
      await insertBadgeIfMissing(client, volunteer.id, level);
    }
  }

  return { serviceRecordId, pointsChange };
};

const markBatchRejected = async (
  batchNo: string,
  partnerOrg: string | undefined,
  totalRecords: number,
  message: string
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO partner_batches (batch_no, partner_org, status, total_records, message)
       VALUES ($1, $2, 'rejected', $3, $4)
       ON CONFLICT (batch_no) DO NOTHING`,
      [batchNo, partnerOrg || null, totalRecords, message]
    );
  } finally {
    client.release();
  }
};

export const submitPartnerBatch = async (
  batchNo: string,
  partnerOrg: string | undefined,
  records: PartnerBatchRecord[]
): Promise<ApiResponse<any>> => {
  const duplicateNos = findDuplicateRecordNos(records);
  if (duplicateNos.length > 0) {
    await markBatchRejected(batchNo, partnerOrg, records.length, messages.partnerBatches.duplicateRecordNos);
    return {
      success: false,
      error: messages.partnerBatches.duplicateRecordNos,
      details: { batch_no: batchNo, duplicate_record_nos: duplicateNos },
    };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 认领批次行：并发提交在此串行化，后到者等待先到者提交后再判断幂等结果
    await client.query(
      `INSERT INTO partner_batches (batch_no, partner_org, status, total_records)
       VALUES ($1, $2, 'processing', $3)
       ON CONFLICT (batch_no) DO NOTHING`,
      [batchNo, partnerOrg || null, records.length]
    );

    const batchResult = await client.query(
      'SELECT * FROM partner_batches WHERE batch_no = $1 FOR UPDATE',
      [batchNo]
    );
    const batch = batchResult.rows[0];

    const existingResult = await client.query(
      'SELECT * FROM partner_service_records WHERE batch_no = $1',
      [batchNo]
    );
    const existingByNo = new Map<string, PartnerServiceRecord>(
      existingResult.rows.map((row: PartnerServiceRecord) => [row.external_record_no, row])
    );

    if (existingByNo.size > 0) {
      // 批次已接收过：逐条比对内容，全部一致回复已接收，任何不一致拒绝本批
      const results: PartnerRecordResult[] = [];
      const conflicts: PartnerRecordConflict[] = [];

      for (const record of records) {
        const existing = existingByNo.get(record.external_record_no);
        if (!existing) {
          conflicts.push({
            external_record_no: record.external_record_no,
            reason: messages.partnerBatches.unknownRecordNo,
            incoming: snapshotOf(record),
          });
          results.push({ external_record_no: record.external_record_no, status: 'conflict' });
          continue;
        }

        if (existing.content_hash !== hashPartnerRecord(record)) {
          const storedSnapshot = snapshotOfStored(existing);
          const incomingSnapshot = snapshotOf(record);
          conflicts.push({
            external_record_no: record.external_record_no,
            reason: messages.partnerBatches.contentChanged,
            existing: storedSnapshot,
            incoming: incomingSnapshot,
            diff_fields: diffFields(storedSnapshot, incomingSnapshot),
          });
          results.push({ external_record_no: record.external_record_no, status: 'conflict' });
          continue;
        }

        results.push({
          external_record_no: record.external_record_no,
          status: 'duplicate',
          service_record_id: existing.service_record_id,
        });
      }

      if (conflicts.length > 0) {
        await client.query(
          `UPDATE partner_batches
           SET status = 'conflicted', conflict_count = $2, conflict_details = $3, message = $4
           WHERE batch_no = $1`,
          [batchNo, conflicts.length, JSON.stringify(conflicts), messages.partnerBatches.conflict]
        );
        await client.query('COMMIT');
        return {
          success: false,
          error: messages.partnerBatches.conflict,
          details: {
            batch_no: batchNo,
            status: 'conflicted',
            conflict_count: conflicts.length,
            duplicate_count: results.filter((r) => r.status === 'duplicate').length,
            conflicts,
            results,
          },
        };
      }

      await client.query(
        `UPDATE partner_batches
         SET duplicate_count = duplicate_count + $2, message = $3
         WHERE batch_no = $1`,
        [batchNo, results.length, messages.partnerBatches.alreadyReceived]
      );
      await client.query('COMMIT');
      return {
        success: true,
        message: messages.partnerBatches.alreadyReceived,
        data: {
          batch_no: batchNo,
          status: 'duplicate',
          total: records.length,
          duplicate_count: results.length,
          new_count: 0,
          results,
        },
      };
    }

    // 首次接收：先验证全部条目，任何无效条目整批拒绝、一条不写
    const invalidResults: PartnerRecordResult[] = [];
    for (const record of records) {
      const volunteerResult = await client.query(
        'SELECT * FROM volunteers WHERE id = $1',
        [record.volunteer_id]
      );
      if (volunteerResult.rows.length === 0) {
        invalidResults.push({
          external_record_no: record.external_record_no,
          status: 'invalid',
          error: messages.partnerBatches.volunteerNotFound,
        });
        continue;
      }
      const volunteer = volunteerResult.rows[0] as Volunteer;
      if (isCreditLimited(volunteer.credit_score)) {
        invalidResults.push({
          external_record_no: record.external_record_no,
          status: 'invalid',
          error: messages.partnerBatches.creditLimited,
        });
      }
    }

    if (invalidResults.length > 0) {
      await client.query(
        `UPDATE partner_batches
         SET status = 'rejected', message = $2
         WHERE batch_no = $1`,
        [batchNo, messages.partnerBatches.invalidRecords]
      );
      await client.query('COMMIT');
      return {
        success: false,
        error: messages.partnerBatches.invalidRecords,
        details: {
          batch_no: batchNo,
          status: 'rejected',
          invalid_records: invalidResults,
        },
      };
    }

    const results: PartnerRecordResult[] = [];
    const involvedVolunteerIds = new Set<string>();

    for (const record of records) {
      const { serviceRecordId, pointsChange } = await applyServiceRecord(client, record);

      await client.query(
        `INSERT INTO partner_service_records
         (batch_no, external_record_no, volunteer_id, service_type, duration_hours, rating, is_no_show, content_hash, service_record_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          batchNo,
          record.external_record_no,
          record.volunteer_id,
          record.service_type,
          record.duration_hours,
          record.rating,
          record.is_no_show || false,
          hashPartnerRecord(record),
          serviceRecordId,
        ]
      );

      involvedVolunteerIds.add(record.volunteer_id);
      results.push({
        external_record_no: record.external_record_no,
        status: 'new',
        service_record_id: serviceRecordId,
        points_change: pointsChange,
      });
    }

    await client.query(
      `UPDATE partner_batches
       SET status = 'processed', new_count = $2, message = $3
       WHERE batch_no = $1`,
      [batchNo, results.length, messages.partnerBatches.processed]
    );

    await client.query('COMMIT');

    // 事务提交后重算信用分，与单条创建流程保持一致
    const creditSummaries: Record<string, { creditScore: number; creditChange: number }> = {};
    for (const volunteerId of involvedVolunteerIds) {
      const creditResult = await recalculateCreditScore(volunteerId);
      if (creditResult && creditResult.changeAmount !== 0) {
        await logCreditChange(
          volunteerId,
          creditResult.changeAmount,
          `机构批次入账-信用分重算: ${batchNo}`,
          creditResult.beforeScore,
          creditResult.afterScore,
          undefined,
          'partner_batch'
        );
      }
      if (creditResult) {
        creditSummaries[volunteerId] = {
          creditScore: creditResult.afterScore,
          creditChange: creditResult.changeAmount,
        };
      }
    }

    return {
      success: true,
      message: messages.partnerBatches.processed,
      data: {
        batch_no: batchNo,
        status: 'processed',
        total: records.length,
        new_count: results.length,
        duplicate_count: 0,
        results,
        credit: creditSummaries,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.submitPartnerBatchFailed, error);
    return { success: false, error: messages.partnerBatches.submitFailed };
  } finally {
    client.release();
  }
};

export const getPartnerBatchByNo = async (batchNo: string): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const batchResult = await client.query(
      'SELECT * FROM partner_batches WHERE batch_no = $1',
      [batchNo]
    );

    if (batchResult.rows.length === 0) {
      return { success: false, error: messages.partnerBatches.notFound };
    }

    const recordsResult = await client.query(
      `SELECT psr.*, sr.points_earned, sr.recorded_at
       FROM partner_service_records psr
       LEFT JOIN service_records sr ON sr.id = psr.service_record_id
       WHERE psr.batch_no = $1
       ORDER BY psr.created_at, psr.external_record_no`,
      [batchNo]
    );

    const batch = batchResult.rows[0];
    const records = recordsResult.rows.map((row) => ({
      external_record_no: row.external_record_no,
      status: 'new',
      volunteer_id: row.volunteer_id,
      service_type: row.service_type,
      duration_hours: Number(row.duration_hours),
      rating: row.rating,
      is_no_show: row.is_no_show,
      service_record_id: row.service_record_id,
      points_earned: row.points_earned,
      recorded_at: row.recorded_at,
    }));

    return {
      success: true,
      data: {
        batch,
        records,
        conflicts: batch.conflict_details || [],
        summary: {
          total_records: batch.total_records,
          new_count: batch.new_count,
          duplicate_count: batch.duplicate_count,
          conflict_count: batch.conflict_count,
        },
      },
    };
  } finally {
    client.release();
  }
};

export const getPartnerBatches = async (
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;

    const countResult = await client.query('SELECT COUNT(*) as total FROM partner_batches');
    const batchesResult = await client.query(
      `SELECT * FROM partner_batches
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    return {
      success: true,
      data: {
        batches: batchesResult.rows,
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
