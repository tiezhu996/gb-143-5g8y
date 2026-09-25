import { createHash } from 'crypto';
import { PoolClient } from 'pg';
import {
  PartnerBatchUploadInput,
  PartnerBatchUploadResult,
  PartnerBatchItemInput,
  BatchConflictItem,
  ServiceBatch,
  ServiceBatchItem,
  Volunteer,
  ApiResponse,
} from '../types';
import pool from '../db/pool';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel } from './badgeService';
import { isCreditLimited, CREDIT_LIMIT_THRESHOLD, MIN_CREDIT_SCORE, MAX_CREDIT_SCORE } from './creditService';
import { messages } from '../constants/messages';
import { logger } from '../utils/logger';

// 参与"同件内容是否一致"判定的字段（location/description 为备注信息，不参与冲突判定）
type ComparedField =
  | 'volunteer_id'
  | 'service_type'
  | 'duration_hours'
  | 'rating'
  | 'is_no_show'
  | 'missing_existing'
  | 'missing_in_payload';

const FIELD_LABELS: Record<ComparedField, string> = {
  volunteer_id: '志愿者ID',
  service_type: '服务类型',
  duration_hours: '服务时长',
  rating: '评分',
  is_no_show: '是否爽约',
  missing_existing: '来件多出条目',
  missing_in_payload: '来件缺少条目',
};

const normalizeDuration = (value: number): number => Math.round(value * 100) / 100;

const normalizeItem = (item: PartnerBatchItemInput) => ({
  org_record_no: item.org_record_no,
  volunteer_id: item.volunteer_id,
  service_type: item.service_type,
  duration_hours: normalizeDuration(item.duration_hours),
  rating: item.rating,
  is_no_show: item.is_no_show ?? false,
  location: item.location ?? null,
  description: item.description ?? null,
});

type NormalizedItem = ReturnType<typeof normalizeItem>;

// 内容指纹：同批次号重试时快速判断来件整体是否一致
export const computeBatchContentHash = (records: NormalizedItem[]): string => {
  const canonical = JSON.stringify(
    records
      .map((r) => ({
        org_record_no: r.org_record_no,
        volunteer_id: r.volunteer_id,
        service_type: r.service_type,
        duration_hours: r.duration_hours.toFixed(2),
        rating: r.rating,
        is_no_show: r.is_no_show,
      }))
      .sort((a, b) => (a.org_record_no < b.org_record_no ? -1 : 1))
  );
  return createHash('sha256').update(canonical).digest('hex');
};

interface ExistingRecordRow {
  id: string;
  org_record_no: string;
  volunteer_id: string;
  service_type: string;
  duration_hours: string;
  rating: number;
  is_no_show: boolean;
}

const compareItemWithExisting = (item: NormalizedItem, existing: ExistingRecordRow): BatchConflictItem | null => {
  const make = (
    conflictField: ComparedField,
    existingValue: string | null,
    receivedValue: string | null
  ): BatchConflictItem => ({
    org_record_no: item.org_record_no,
    conflict_field: conflictField,
    conflict_field_label: FIELD_LABELS[conflictField],
    existing_value: existingValue,
    received_value: receivedValue,
  });

  if (existing.volunteer_id !== item.volunteer_id) {
    return make('volunteer_id', existing.volunteer_id, item.volunteer_id);
  }
  if (existing.service_type !== item.service_type) {
    return make('service_type', existing.service_type, item.service_type);
  }
  if (Number(existing.duration_hours) !== item.duration_hours) {
    return make('duration_hours', existing.duration_hours, item.duration_hours.toFixed(2));
  }
  if (existing.rating !== item.rating) {
    return make('rating', String(existing.rating), String(item.rating));
  }
  if (existing.is_no_show !== item.is_no_show) {
    return make('is_no_show', String(existing.is_no_show), String(item.is_no_show));
  }
  return null;
};

// 对照既有锚点记录逐项判定：内容一致 duplicate，改了核心字段/条目数不一致 conflict
const evaluateAgainstRecords = async (
  client: PoolClient,
  batchNo: string,
  records: NormalizedItem[]
): Promise<{ conflicts: BatchConflictItem[]; duplicateCount: number; existingByOrgNo: Map<string, ExistingRecordRow> }> => {
  // 取该批次全部锚点记录：既能对照来件字段，也能为来件缺失条目提供留痕所需的既有值
  const existingResult = await client.query(
    `SELECT id, org_record_no, volunteer_id, service_type, duration_hours, rating, is_no_show
     FROM service_records
     WHERE batch_no = $1`,
    [batchNo]
  );

  const existingByOrgNo = new Map<string, ExistingRecordRow>();
  for (const row of existingResult.rows as ExistingRecordRow[]) {
    existingByOrgNo.set(row.org_record_no, row);
  }

  const conflicts: BatchConflictItem[] = [];
  let duplicateCount = 0;

  for (const item of records) {
    const existing = existingByOrgNo.get(item.org_record_no);
    if (!existing) {
      conflicts.push({
        org_record_no: item.org_record_no,
        conflict_field: 'missing_existing',
        conflict_field_label: FIELD_LABELS.missing_existing,
        existing_value: null,
        received_value: 'present',
      });
      continue;
    }
    const conflict = compareItemWithExisting(item, existing);
    if (conflict) {
      conflicts.push(conflict);
    } else {
      duplicateCount += 1;
    }
  }

  // 来件比既有批次少条目：从全量锚点中找出被漏掉的条目
  const submittedNos = new Set(records.map((r) => r.org_record_no));
  for (const [orgRecordNo] of existingByOrgNo) {
    if (!submittedNos.has(orgRecordNo)) {
      conflicts.push({
        org_record_no: orgRecordNo,
        conflict_field: 'missing_in_payload',
        conflict_field_label: FIELD_LABELS.missing_in_payload,
        existing_value: 'present',
        received_value: null,
      });
    }
  }

  return { conflicts, duplicateCount, existingByOrgNo };
};

// 在同一事务内重算单个志愿者信用分，保证批次落账时积分与信用流水同事务
const recalculateCreditInTx = async (
  client: PoolClient,
  volunteerId: string
): Promise<{ changeAmount: number; beforeScore: number; afterScore: number } | null> => {
  const volunteerResult = await client.query(
    'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
    [volunteerId]
  );
  if (volunteerResult.rows.length === 0) {
    return null;
  }

  const volunteer = volunteerResult.rows[0] as Volunteer;
  const beforeScore = volunteer.credit_score;

  const servicesResult = await client.query(
    'SELECT * FROM service_records WHERE volunteer_id = $1 ORDER BY recorded_at DESC LIMIT 50',
    [volunteerId]
  );
  const recentServices = servicesResult.rows;

  const complaintsResult = await client.query(
    "SELECT * FROM complaints WHERE volunteer_id = $1 AND status IN ('pending', 'resolved')",
    [volunteerId]
  );

  const noShowResult = await client.query(
    'SELECT COUNT(*) as count FROM service_records WHERE volunteer_id = $1 AND is_no_show = true',
    [volunteerId]
  );
  const noShowCount = parseInt(noShowResult.rows[0].count);

  let score = 100;
  score += Math.min(volunteer.service_count * 0.5, 10);

  if (recentServices.length > 0) {
    const averageRating = recentServices.reduce((sum: number, s: any) => sum + s.rating, 0) / recentServices.length;
    score += (averageRating - 3) * 15;
  }

  score -= noShowCount * 20;
  score -= complaintsResult.rows.length * 15;

  const afterScore = Math.max(MIN_CREDIT_SCORE, Math.min(MAX_CREDIT_SCORE, Math.round(score)));
  const changeAmount = afterScore - beforeScore;

  if (changeAmount !== 0) {
    await client.query(
      'UPDATE volunteers SET credit_score = $1 WHERE id = $2',
      [afterScore, volunteerId]
    );
  }

  return { changeAmount, beforeScore, afterScore };
};

const BADGE_NAMES: Record<number, string> = {
  1: '一星志愿者', 2: '二星志愿者', 3: '三星志愿者', 4: '四星志愿者', 5: '五星志愿者',
};

const BADGE_DESCRIPTIONS: Record<number, string> = {
  1: '初入志愿服务，迈出奉献第一步',
  2: '坚持服务，展现热忱之心',
  3: '积极奉献，成为志愿中坚',
  4: '资深志愿者，榜样力量',
  5: '卓越志愿者，公益楷模',
};

interface AcceptedItemContext {
  item: NormalizedItem;
  volunteer: Volunteer;
  pointsChange: number;
  newRecordId: string;
}

class BusinessValidationError extends Error {
  details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.name = 'BusinessValidationError';
    this.details = details;
  }
}

// 首批：整批校验通过后一次事务落账，任何条目无效则抛 BusinessValidationError，整批不写
const acceptNewBatch = async (
  client: PoolClient,
  batch: PartnerBatchUploadInput,
  records: NormalizedItem[],
  contentHash: string
): Promise<PartnerBatchUploadResult> => {
  const partnerId = batch.partner_id;
  const batchNo = batch.batch_no;

  // 1) 逐条目校验志愿者存在性/启用状态/信用门槛（行锁顺带锁定，任一失败即整批拒绝）
  const volunteerCache = new Map<string, Volunteer>();
  for (const item of records) {
    if (volunteerCache.has(item.volunteer_id)) {
      continue;
    }
    const result = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [item.volunteer_id]
    );
    if (result.rows.length === 0) {
      throw new BusinessValidationError(messages.batches.volunteerNotFound(item.org_record_no), {
        org_record_no: item.org_record_no,
        reason: 'volunteer_not_found',
      });
    }
    const volunteer = result.rows[0] as Volunteer;
    if (!volunteer.is_active) {
      throw new BusinessValidationError(`条目 ${item.org_record_no} 对应的志愿者已停用`, {
        org_record_no: item.org_record_no,
        reason: 'volunteer_inactive',
      });
    }
    if (isCreditLimited(volunteer.credit_score)) {
      throw new BusinessValidationError(messages.batches.creditLimited(item.org_record_no), {
        org_record_no: item.org_record_no,
        reason: 'credit_limited',
        credit_score: volunteer.credit_score,
        credit_limit_threshold: CREDIT_LIMIT_THRESHOLD,
      });
    }
    volunteerCache.set(item.volunteer_id, volunteer);
  }

  // 2) 写服务记录（(batch_no, org_record_no) 唯一索引兜底，并发下绝不重复落账）
  const acceptedContexts: AcceptedItemContext[] = [];
  for (const item of records) {
    const pointsEarned = item.is_no_show ? 0 : calculatePoints(
      item.duration_hours,
      item.service_type,
      item.rating
    );
    const pointsChange = item.is_no_show ? -calculateNoShowPenalty() : pointsEarned;

    const insertResult = await client.query(
      `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show,
        location, description, batch_no, org_record_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        item.volunteer_id,
        item.service_type,
        item.duration_hours,
        item.rating,
        pointsEarned,
        item.is_no_show,
        item.location,
        item.description,
        batchNo,
        item.org_record_no,
      ]
    );

    acceptedContexts.push({
      item,
      volunteer: volunteerCache.get(item.volunteer_id)!,
      pointsChange,
      newRecordId: insertResult.rows[0].id,
    });
  }

  // 3) 志愿者累计积分/等级更新（按志愿者条目顺序累计），徽章补齐
  const runningPoints = new Map<string, number>();
  const logEntries: { ctx: AcceptedItemContext; before: number; after: number }[] = [];
  const volunteerAgg = new Map<string, { points: number; services: number }>();
  for (const ctx of acceptedContexts) {
    if (!runningPoints.has(ctx.item.volunteer_id)) {
      runningPoints.set(ctx.item.volunteer_id, ctx.volunteer.total_points);
      volunteerAgg.set(ctx.item.volunteer_id, { points: 0, services: 0 });
    }
    const before = runningPoints.get(ctx.item.volunteer_id)!;
    const after = Math.max(0, before + ctx.pointsChange);
    runningPoints.set(ctx.item.volunteer_id, after);
    logEntries.push({ ctx, before, after });

    const agg = volunteerAgg.get(ctx.item.volunteer_id)!;
    agg.points += ctx.pointsChange;
    if (!ctx.item.is_no_show) {
      agg.services += 1;
    }
  }

  for (const [volunteerId, agg] of volunteerAgg) {
    const volunteer = volunteerCache.get(volunteerId)!;
    const newTotalPoints = Math.max(0, volunteer.total_points + agg.points);
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
       SET total_points = $1, level = $2, service_count = service_count + $3
       WHERE id = $4`,
      [newTotalPoints, newLevel, agg.services, volunteerId]
    );

    if (newLevel > oldLevel) {
      const badgeRows = await client.query(
        'SELECT star_level FROM badges WHERE volunteer_id = $1',
        [volunteerId]
      );
      const existingLevels = new Set(badgeRows.rows.map((b: { star_level: number }) => b.star_level));
      for (let level = oldLevel + 1; level <= newLevel; level++) {
        if (!existingLevels.has(level)) {
          await client.query(
            `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (volunteer_id, star_level) DO NOTHING`,
            [volunteerId, level, BADGE_NAMES[level], BADGE_DESCRIPTIONS[level]]
          );
        }
      }
    }
  }

  // 4) 逐条积分流水（一套流水，重试不再产生）
  for (const { ctx, before, after } of logEntries) {
    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ctx.item.volunteer_id,
        ctx.pointsChange,
        ctx.item.is_no_show
          ? `爽约扣分: 批次${batchNo}/${ctx.item.org_record_no}`
          : `服务积分: ${ctx.item.service_type} (批次${batchNo}/${ctx.item.org_record_no})`,
        before,
        after,
        ctx.newRecordId,
        'partner_batch',
      ]
    );
  }

  // 5) 批次主表（占位行更新为 accepted）与条目明细（首批 = 第 1 次来件）
  await client.query(
    `UPDATE service_batches
     SET status = 'accepted', item_count = $2, accepted_count = $2,
         duplicate_count = 0, conflict_count = 0, content_hash = $3, conflict_items = NULL,
         attempt_no = 1, request_count = 1
     WHERE batch_no = $1`,
    [batchNo, records.length, contentHash]
  );

  for (const ctx of acceptedContexts) {
    await client.query(
      `INSERT INTO service_batch_items
         (batch_no, attempt_no, org_record_no, partner_id, volunteer_id, service_type, duration_hours,
          rating, is_no_show, location, description, result_status, service_record_id)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'accepted', $11)`,
      [
        batchNo,
        ctx.item.org_record_no,
        partnerId,
        ctx.item.volunteer_id,
        ctx.item.service_type,
        ctx.item.duration_hours,
        ctx.item.rating,
        ctx.item.is_no_show,
        ctx.item.location,
        ctx.item.description,
        ctx.newRecordId,
      ]
    );
  }

  // 6) 信用分重算与信用流水（按志愿者去重，同事务）
  const creditVolunteers = [...new Set(acceptedContexts.map((c) => c.item.volunteer_id))];
  for (const volunteerId of creditVolunteers) {
    const credit = await recalculateCreditInTx(client, volunteerId);
    if (credit && credit.changeAmount !== 0) {
      await client.query(
        `INSERT INTO credit_logs (volunteer_id, change_amount, reason, before_score, after_score, related_type)
         VALUES ($1, $2, $3, $4, $5, 'partner_batch')`,
        [
          volunteerId,
          credit.changeAmount,
          `合作机构批量来件-信用分重算: 批次${batchNo}`,
          credit.beforeScore,
          credit.afterScore,
        ]
      );
    }
  }

  return {
    status: 'accepted',
    batch_no: batchNo,
    total: records.length,
    accepted_count: records.length,
    duplicate_count: 0,
    conflict_count: 0,
  };
};

// 重试落痕：内容一致 → duplicate；有冲突 → conflict（均不改动既有服务记录与积分）
// 每次来件追加一批 attempt 明细，首批新增与各次重试结果都保留可查
const persistRetryOutcome = async (
  client: PoolClient,
  batch: PartnerBatchUploadInput,
  records: NormalizedItem[],
  contentHash: string,
  conflicts: BatchConflictItem[],
  duplicateCount: number,
  existingByOrgNo: Map<string, ExistingRecordRow>
): Promise<PartnerBatchUploadResult> => {
  const { batch_no: batchNo, partner_id: partnerId } = batch;
  const status = conflicts.length > 0 ? 'conflict' : 'duplicate';
  const conflictByNo = new Map(conflicts.map((c) => [c.org_record_no, c]));

  const currentRow = await client.query(
    'SELECT attempt_no FROM service_batches WHERE batch_no = $1 FOR UPDATE',
    [batchNo]
  );
  const attemptNo = (currentRow.rows[0]?.attempt_no ?? 1) + 1;

  await client.query(
    `UPDATE service_batches
     SET status = $2, item_count = $3, duplicate_count = $4, conflict_count = $5,
         content_hash = $6, conflict_items = $7, attempt_no = $8,
         request_count = request_count + 1, last_received_at = CURRENT_TIMESTAMP
     WHERE batch_no = $1`,
    [
      batchNo,
      status,
      records.length,
      duplicateCount,
      conflicts.length,
      contentHash,
      conflicts.length > 0 ? JSON.stringify(conflicts) : null,
      attemptNo,
    ]
  );

  for (const item of records) {
    const conflict = conflictByNo.get(item.org_record_no);
    const existing = existingByOrgNo.get(item.org_record_no);
    await client.query(
      `INSERT INTO service_batch_items
         (batch_no, attempt_no, org_record_no, partner_id, volunteer_id, service_type, duration_hours,
          rating, is_no_show, location, description, result_status, service_record_id,
          conflict_field, existing_value, received_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        batchNo,
        attemptNo,
        item.org_record_no,
        partnerId,
        item.volunteer_id,
        item.service_type,
        item.duration_hours,
        item.rating,
        item.is_no_show,
        item.location,
        item.description,
        conflict ? 'conflict' : 'duplicate',
        existing ? existing.id : null,
        conflict ? conflict.conflict_field : null,
        conflict ? conflict.existing_value : null,
        conflict ? conflict.received_value : null,
      ]
    );
  }

  // 来件缺失的既有条目也要在本次 attempt 中留一条 conflict 明细，内容取既有记录
  const payloadNos = new Set(records.map((r) => r.org_record_no));
  for (const conflict of conflicts) {
    if (conflict.conflict_field !== 'missing_in_payload' || payloadNos.has(conflict.org_record_no)) {
      continue;
    }
    const existing = existingByOrgNo.get(conflict.org_record_no)!;
    await client.query(
      `INSERT INTO service_batch_items
         (batch_no, attempt_no, org_record_no, partner_id, volunteer_id, service_type, duration_hours,
          rating, is_no_show, result_status, service_record_id,
          conflict_field, existing_value, received_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'conflict',$10,'missing_in_payload','present',NULL)`,
      [
        batchNo,
        attemptNo,
        conflict.org_record_no,
        partnerId,
        existing.volunteer_id,
        existing.service_type,
        existing.duration_hours,
        existing.rating,
        existing.is_no_show,
        existing.id,
      ]
    );
  }

  return {
    status,
    batch_no: batchNo,
    total: records.length,
    accepted_count: 0,
    duplicate_count: duplicateCount,
    conflict_count: conflicts.length,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  };
};

export const uploadPartnerBatch = async (
  batch: PartnerBatchUploadInput
): Promise<ApiResponse<PartnerBatchUploadResult>> => {
  const records = batch.records.map(normalizeItem);

  // 批次内机构记录号重复 → 无效提交，一条也不写
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.org_record_no)) {
      return {
        success: false,
        error: messages.batches.duplicateInBatch,
        details: { org_record_no: record.org_record_no, reason: 'duplicate_org_record_no' },
      };
    }
    seen.add(record.org_record_no);
  }

  const contentHash = computeBatchContentHash(records);
  const client = await pool.connect();

  // 单次事务尝试。返回 undefined 表示先行者回滚释放了批次号，需要重新抢注
  const attempt = async (): Promise<ApiResponse<PartnerBatchUploadResult> | undefined> => {
    try {
      await client.query('BEGIN');

      // 以批次主表行作为互斥量：ON CONFLICT DO NOTHING 抢注；抢注失败者
      // 用 SELECT ... FOR UPDATE 等待先行者事务提交，保证同批次并发串行
      const lockResult = await client.query(
        `INSERT INTO service_batches (batch_no, partner_id, status, item_count, content_hash)
         VALUES ($1, $2, 'accepted', $3, $4)
         ON CONFLICT (batch_no) DO NOTHING
         RETURNING batch_no`,
        [batch.batch_no, batch.partner_id, records.length, contentHash]
      );
      const isOwner = lockResult.rows.length === 1;

      if (!isOwner) {
        const lockRow = await client.query(
          'SELECT partner_id FROM service_batches WHERE batch_no = $1 FOR UPDATE',
          [batch.batch_no]
        );

        // 先行者回滚（如整批校验失败）会连带删除/消失占位行 → 本次重来
        if (lockRow.rows.length === 0) {
          await client.query('ROLLBACK').catch(() => undefined);
          return undefined;
        }

        if (lockRow.rows[0].partner_id !== batch.partner_id) {
          await client.query('ROLLBACK');
          return {
            success: false,
            error: `批次号 ${batch.batch_no} 已归属其他合作机构`,
            details: { batch_no: batch.batch_no, reason: 'partner_mismatch' },
          };
        }
      }

      // 既有锚点记录：存在则按重试判定，不存在则首批落账
      const anchorResult = await client.query(
        'SELECT org_record_no FROM service_records WHERE batch_no = $1 LIMIT 1',
        [batch.batch_no]
      );

      let result: PartnerBatchUploadResult;
      if (anchorResult.rows.length === 0) {
        try {
          result = await acceptNewBatch(client, batch, records, contentHash);
        } catch (acceptError) {
          // 业务校验失败（志愿者不存在/停用/信用受限）：整批回滚，不留下批次占位与半批数据
          await client.query('ROLLBACK').catch(() => undefined);
          if (acceptError instanceof BusinessValidationError) {
            return { success: false, error: acceptError.message, details: acceptError.details };
          }
          throw acceptError;
        }
      } else {
        const { conflicts, duplicateCount, existingByOrgNo } = await evaluateAgainstRecords(
          client,
          batch.batch_no,
          records
        );
        result = await persistRetryOutcome(
          client,
          batch,
          records,
          contentHash,
          conflicts,
          duplicateCount,
          existingByOrgNo
        );
      }

      await client.query('COMMIT');
      return { success: true, data: result };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  };

  try {
    // 极端并发下最多重抢一次（两路同批且先行者校验失败回滚）
    let response = await attempt();
    if (response === undefined) {
      response = await attempt();
    }
    if (response === undefined) {
      return { success: false, error: messages.batches.uploadFailed };
    }
    return response;
  } catch (error) {
    logger.error(messages.logs.partnerBatchUploadFailed, error);
    return { success: false, error: messages.batches.uploadFailed };
  } finally {
    client.release();
  }
};

export const getBatchByNo = async (batchNo: string): Promise<ApiResponse<any>> => {
  const client = await pool.connect();
  try {
    const batchResult = await client.query(
      'SELECT * FROM service_batches WHERE batch_no = $1',
      [batchNo]
    );
    if (batchResult.rows.length === 0) {
      return { success: false, error: messages.batches.batchNotFound };
    }

    const itemsResult = await client.query(
      'SELECT * FROM service_batch_items WHERE batch_no = $1 ORDER BY org_record_no',
      [batchNo]
    );

    const batch = batchResult.rows[0] as ServiceBatch;
    const items = itemsResult.rows as ServiceBatchItem[];

    // 按来件次数分组：每次重试单独一组，新增/已接收/冲突全过程可查
    const attemptMap = new Map<number, any>();
    for (const item of items) {
      if (!attemptMap.has(item.attempt_no)) {
        attemptMap.set(item.attempt_no, {
          attempt_no: item.attempt_no,
          created_at: item.created_at,
          accepted: 0,
          duplicate: 0,
          conflict: 0,
          items: [] as any[],
        });
      }
      const group = attemptMap.get(item.attempt_no);
      group[item.result_status] += 1;
      group.items.push({
        org_record_no: item.org_record_no,
        volunteer_id: item.volunteer_id,
        service_type: item.service_type,
        duration_hours: item.duration_hours,
        rating: item.rating,
        is_no_show: item.is_no_show,
        result_status: item.result_status,
        service_record_id: item.service_record_id,
        conflict_field: item.conflict_field,
        conflict_field_label: item.conflict_field
          ? FIELD_LABELS[item.conflict_field as ComparedField] ?? item.conflict_field
          : null,
        existing_value: item.existing_value,
        received_value: item.received_value,
      });
    }
    const attempts = [...attemptMap.values()].sort((a, b) => a.attempt_no - b.attempt_no);

    return {
      success: true,
      data: {
        batch: {
          batch_no: batch.batch_no,
          partner_id: batch.partner_id,
          status: batch.status,
          item_count: batch.item_count,
          accepted_count: batch.accepted_count,
          duplicate_count: batch.duplicate_count,
          conflict_count: batch.conflict_count,
          request_count: batch.request_count,
          attempt_no: batch.attempt_no,
          first_received_at: batch.first_received_at,
          last_received_at: batch.last_received_at,
        },
        conflicts: (batch.conflict_items ?? []).map((c) => ({
          ...c,
          conflict_field_label:
            FIELD_LABELS[c.conflict_field as ComparedField] ?? c.conflict_field,
        })),
        attempts,
        // 跨所有来件次数的累计视角：新增（首批）、已接收（各次重试命中）、冲突
        totals: {
          accepted: items.filter((i) => i.result_status === 'accepted').length,
          duplicate: items.filter((i) => i.result_status === 'duplicate').length,
          conflict: items.filter((i) => i.result_status === 'conflict').length,
        },
      },
    };
  } catch (error) {
    logger.error(messages.batches.queryFailed, error);
    return { success: false, error: messages.batches.queryFailed };
  } finally {
    client.release();
  }
};

export const listBatches = async (
  page: number,
  pageSize: number,
  status?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();
  try {
    const offset = (page - 1) * pageSize;
    const validStatuses = ['accepted', 'duplicate', 'conflict'];
    const filterStatus = status && validStatuses.includes(status) ? status : null;

    const countResult = await client.query(
      'SELECT COUNT(*) as total FROM service_batches WHERE ($1::varchar IS NULL OR status = $1)',
      [filterStatus]
    );

    const rowsResult = await client.query(
      `SELECT batch_no, partner_id, status, item_count, accepted_count, duplicate_count,
              conflict_count, request_count, first_received_at, last_received_at
       FROM service_batches
       WHERE ($1::varchar IS NULL OR status = $1)
       ORDER BY last_received_at DESC
       LIMIT $2 OFFSET $3`,
      [filterStatus, pageSize, offset]
    );

    const total = parseInt(countResult.rows[0].total);
    return {
      success: true,
      data: {
        batches: rowsResult.rows,
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.ceil(total / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};
